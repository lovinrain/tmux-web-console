from __future__ import annotations

import asyncio
import logging
import math
import os
import socket
import time
from collections import deque
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

LOGGER = logging.getLogger("muxdeck.host_metrics")
HOST_METRIC_RANGES = {
    "15m": 15 * 60,
    "1h": 60 * 60,
    "24h": 24 * 60 * 60,
}
DEFAULT_SAMPLE_SECONDS = 5.0
DEFAULT_REQUEST_CACHE_SECONDS = 1.0
DEFAULT_BOOTSTRAP_SECONDS = 0.2
MAX_HISTORY_POINTS = 180


class HostMetricsUnavailableError(RuntimeError):
    pass


@dataclass(frozen=True)
class PressureAverages:
    avg10: float
    avg60: float
    avg300: float

    def payload(self) -> dict[str, float]:
        return {
            "avg10": self.avg10,
            "avg60": self.avg60,
            "avg300": self.avg300,
        }


@dataclass(frozen=True)
class HostCounters:
    cpu_total: int
    cpu_idle: int
    memory_total_bytes: int
    memory_available_bytes: int
    swap_total_bytes: int
    swap_free_bytes: int
    load_average: tuple[float, float, float]
    cpu_count: int
    hostname: str
    cpu_cores: tuple[tuple[int, int], ...] = ()
    memory_pressure_some: PressureAverages | None = None
    memory_pressure_full: PressureAverages | None = None
    swap_in_pages: int | None = None
    swap_out_pages: int | None = None
    page_size_bytes: int = 4096


@dataclass(frozen=True)
class HostMetricSample:
    observed_at: float
    cpu_percent: float | None
    cpu_core_percents: tuple[float | None, ...]
    memory_total_bytes: int
    memory_used_bytes: int
    memory_available_bytes: int
    memory_pressure_some: PressureAverages | None
    memory_pressure_full: PressureAverages | None
    swap_total_bytes: int
    swap_used_bytes: int
    swap_in_bytes_per_second: float | None
    swap_out_bytes_per_second: float | None
    load_average: tuple[float, float, float]
    cpu_count: int
    hostname: str

    def latest_payload(self) -> dict[str, Any]:
        pressure = None
        if self.memory_pressure_some is not None or self.memory_pressure_full is not None:
            pressure = {
                "some": (
                    self.memory_pressure_some.payload()
                    if self.memory_pressure_some is not None
                    else None
                ),
                "full": (
                    self.memory_pressure_full.payload()
                    if self.memory_pressure_full is not None
                    else None
                ),
            }
        return {
            "observedAt": round(self.observed_at, 3),
            "cpuPercent": self.cpu_percent,
            "cpuCores": list(self.cpu_core_percents),
            "memoryTotalBytes": self.memory_total_bytes,
            "memoryUsedBytes": self.memory_used_bytes,
            "memoryAvailableBytes": self.memory_available_bytes,
            "memoryPressure": pressure,
            "swapTotalBytes": self.swap_total_bytes,
            "swapUsedBytes": self.swap_used_bytes,
            "swapInBytesPerSecond": self.swap_in_bytes_per_second,
            "swapOutBytesPerSecond": self.swap_out_bytes_per_second,
            "loadAverage": list(self.load_average),
        }


def _parse_meminfo(content: str) -> dict[str, int]:
    values: dict[str, int] = {}
    for line in content.splitlines():
        key, separator, remainder = line.partition(":")
        if not separator:
            continue
        parts = remainder.strip().split()
        if not parts:
            continue
        try:
            value = int(parts[0])
        except ValueError:
            continue
        multiplier = 1024 if len(parts) > 1 and parts[1].lower() == "kb" else 1
        values[key] = value * multiplier
    return values


def _parse_cpu_counters(parts: list[str], source: str) -> tuple[int, int]:
    if len(parts) < 5:
        raise ValueError(f"{source} does not contain usable CPU counters")
    try:
        values = [int(value) for value in parts[1:9]]
    except ValueError as error:
        raise ValueError(f"{source} contains invalid CPU counters") from error
    total = sum(values)
    idle = values[3] + (values[4] if len(values) > 4 else 0)
    return total, idle


def _parse_memory_pressure(
    content: str,
) -> tuple[PressureAverages | None, PressureAverages | None]:
    parsed: dict[str, PressureAverages] = {}
    for line in content.splitlines():
        parts = line.split()
        if not parts or parts[0] not in {"some", "full"}:
            continue
        values: dict[str, float] = {}
        for part in parts[1:]:
            key, separator, raw_value = part.partition("=")
            if not separator or key not in {"avg10", "avg60", "avg300"}:
                continue
            try:
                values[key] = float(raw_value)
            except ValueError:
                continue
        if all(key in values for key in ("avg10", "avg60", "avg300")):
            parsed[parts[0]] = PressureAverages(
                avg10=values["avg10"],
                avg60=values["avg60"],
                avg300=values["avg300"],
            )
    return parsed.get("some"), parsed.get("full")


def _read_optional_memory_pressure(
    pressure_path: Path,
) -> tuple[PressureAverages | None, PressureAverages | None]:
    try:
        return _parse_memory_pressure(pressure_path.read_text(encoding="ascii"))
    except OSError:
        return None, None


def _read_optional_swap_counters(vmstat_path: Path) -> tuple[int | None, int | None]:
    try:
        content = vmstat_path.read_text(encoding="ascii")
    except OSError:
        return None, None
    values: dict[str, int] = {}
    for line in content.splitlines():
        parts = line.split()
        if len(parts) != 2 or parts[0] not in {"pswpin", "pswpout"}:
            continue
        try:
            values[parts[0]] = int(parts[1])
        except ValueError:
            continue
    return values.get("pswpin"), values.get("pswpout")


def read_linux_host_counters(
    stat_path: Path = Path("/proc/stat"),
    meminfo_path: Path = Path("/proc/meminfo"),
    pressure_path: Path = Path("/proc/pressure/memory"),
    vmstat_path: Path = Path("/proc/vmstat"),
) -> HostCounters:
    aggregate: tuple[int, int] | None = None
    cores: list[tuple[int, tuple[int, int]]] = []
    for line in stat_path.read_text(encoding="ascii").splitlines():
        parts = line.split()
        if not parts:
            continue
        label = parts[0]
        if label == "cpu":
            aggregate = _parse_cpu_counters(parts, "/proc/stat")
        elif label.startswith("cpu") and label[3:].isdigit():
            cores.append((int(label[3:]), _parse_cpu_counters(parts, "/proc/stat")))
    if aggregate is None:
        raise ValueError("/proc/stat does not contain aggregate CPU counters")
    cores.sort(key=lambda item: item[0])

    memory = _parse_meminfo(meminfo_path.read_text(encoding="ascii"))
    memory_total = memory.get("MemTotal", 0)
    memory_available = memory.get("MemAvailable")
    if memory_available is None:
        memory_available = sum(
            memory.get(key, 0) for key in ("MemFree", "Buffers", "Cached")
        )
    if memory_total <= 0 or memory_available < 0:
        raise ValueError("/proc/meminfo does not contain usable memory totals")
    memory_available = min(memory_total, memory_available)
    swap_total = max(0, memory.get("SwapTotal", 0))
    swap_free = min(swap_total, max(0, memory.get("SwapFree", 0)))
    pressure_some, pressure_full = _read_optional_memory_pressure(pressure_path)
    swap_in_pages, swap_out_pages = _read_optional_swap_counters(vmstat_path)
    try:
        page_size = int(os.sysconf("SC_PAGE_SIZE"))
    except (OSError, ValueError):
        page_size = 4096
    try:
        load_average = tuple(float(value) for value in os.getloadavg())
    except OSError:
        load_average = (0.0, 0.0, 0.0)

    return HostCounters(
        cpu_total=aggregate[0],
        cpu_idle=aggregate[1],
        memory_total_bytes=memory_total,
        memory_available_bytes=memory_available,
        swap_total_bytes=swap_total,
        swap_free_bytes=swap_free,
        load_average=(load_average[0], load_average[1], load_average[2]),
        cpu_count=len(cores) or os.cpu_count() or 1,
        hostname=socket.gethostname(),
        cpu_cores=tuple(counters for _, counters in cores),
        memory_pressure_some=pressure_some,
        memory_pressure_full=pressure_full,
        swap_in_pages=swap_in_pages,
        swap_out_pages=swap_out_pages,
        page_size_bytes=max(1, page_size),
    )


def _cpu_percent(
    current: tuple[int, int],
    previous: tuple[int, int] | None,
) -> float | None:
    if previous is None:
        return None
    total_delta = current[0] - previous[0]
    idle_delta = current[1] - previous[1]
    if total_delta <= 0 or idle_delta < 0 or idle_delta > total_delta:
        return None
    return round(
        max(0.0, min(100.0, 100.0 * (total_delta - idle_delta) / total_delta)),
        2,
    )


class HostMetricsSampler:
    def __init__(
        self,
        *,
        sample_seconds: float = DEFAULT_SAMPLE_SECONDS,
        history_seconds: float = HOST_METRIC_RANGES["24h"],
        request_cache_seconds: float = DEFAULT_REQUEST_CACHE_SECONDS,
        bootstrap_seconds: float = DEFAULT_BOOTSTRAP_SECONDS,
        reader: Callable[[], HostCounters] = read_linux_host_counters,
        clock: Callable[[], float] = time.time,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        if not math.isfinite(sample_seconds) or sample_seconds <= 0:
            raise ValueError("host metric sample interval must be positive")
        if not math.isfinite(history_seconds) or history_seconds <= 0:
            raise ValueError("host metric history duration must be positive")
        if not math.isfinite(request_cache_seconds) or request_cache_seconds < 0:
            raise ValueError("host metric request cache duration cannot be negative")
        if not math.isfinite(bootstrap_seconds) or bootstrap_seconds < 0:
            raise ValueError("host metric bootstrap duration cannot be negative")
        self.sample_seconds = sample_seconds
        self._request_cache_seconds = request_cache_seconds
        self._bootstrap_seconds = bootstrap_seconds
        self._reader = reader
        self._clock = clock
        self._monotonic = monotonic
        capacity = max(2, math.ceil(history_seconds / sample_seconds) + 2)
        self._history: deque[HostMetricSample] = deque(maxlen=capacity)
        self._previous_cpu: tuple[int, int] | None = None
        self._previous_cpu_cores: tuple[tuple[int, int], ...] = ()
        self._previous_swap: tuple[float, int, int] | None = None
        self._last_sample_monotonic: float | None = None
        self._sample_lock = asyncio.Lock()
        self._last_error: str | None = None

    async def _sample_once_unlocked(self) -> HostMetricSample | None:
        try:
            counters = await asyncio.to_thread(self._reader)
        except (OSError, ValueError) as error:
            message = str(error) or type(error).__name__
            if message != self._last_error:
                LOGGER.warning("Host metrics sampling is unavailable: %s", message)
            self._last_error = message
            return None

        sampled_monotonic = self._monotonic()
        observed_at = self._clock()
        cpu_percent = _cpu_percent(
            (counters.cpu_total, counters.cpu_idle),
            self._previous_cpu,
        )
        cpu_core_percents = tuple(
            _cpu_percent(
                current,
                self._previous_cpu_cores[index]
                if index < len(self._previous_cpu_cores)
                else None,
            )
            for index, current in enumerate(counters.cpu_cores)
        )
        self._previous_cpu = (counters.cpu_total, counters.cpu_idle)
        self._previous_cpu_cores = counters.cpu_cores

        swap_in_rate: float | None = None
        swap_out_rate: float | None = None
        if counters.swap_in_pages is not None and counters.swap_out_pages is not None:
            if self._previous_swap is not None:
                previous_at, previous_in, previous_out = self._previous_swap
                elapsed = sampled_monotonic - previous_at
                in_delta = counters.swap_in_pages - previous_in
                out_delta = counters.swap_out_pages - previous_out
                if elapsed > 0 and in_delta >= 0 and out_delta >= 0:
                    swap_in_rate = round(
                        in_delta * counters.page_size_bytes / elapsed,
                        2,
                    )
                    swap_out_rate = round(
                        out_delta * counters.page_size_bytes / elapsed,
                        2,
                    )
            self._previous_swap = (
                sampled_monotonic,
                counters.swap_in_pages,
                counters.swap_out_pages,
            )

        sample = HostMetricSample(
            observed_at=observed_at,
            cpu_percent=cpu_percent,
            cpu_core_percents=cpu_core_percents,
            memory_total_bytes=counters.memory_total_bytes,
            memory_used_bytes=max(
                0,
                counters.memory_total_bytes - counters.memory_available_bytes,
            ),
            memory_available_bytes=counters.memory_available_bytes,
            memory_pressure_some=counters.memory_pressure_some,
            memory_pressure_full=counters.memory_pressure_full,
            swap_total_bytes=counters.swap_total_bytes,
            swap_used_bytes=max(
                0,
                counters.swap_total_bytes - counters.swap_free_bytes,
            ),
            swap_in_bytes_per_second=swap_in_rate,
            swap_out_bytes_per_second=swap_out_rate,
            load_average=counters.load_average,
            cpu_count=counters.cpu_count,
            hostname=counters.hostname,
        )
        self._history.append(sample)
        self._last_sample_monotonic = sampled_monotonic
        self._last_error = None
        return sample

    async def sample_once(self) -> HostMetricSample | None:
        async with self._sample_lock:
            return await self._sample_once_unlocked()

    async def collect_snapshot(self, range_name: str = "15m") -> dict[str, Any]:
        async with self._sample_lock:
            sampled_at = self._last_sample_monotonic
            cache_fresh = (
                sampled_at is not None
                and self._monotonic() - sampled_at < self._request_cache_seconds
            )
            if not cache_fresh:
                first_sample = not self._history
                sample = await self._sample_once_unlocked()
                if (
                    first_sample
                    and sample is not None
                    and sample.cpu_percent is None
                    and self._bootstrap_seconds > 0
                ):
                    await asyncio.sleep(self._bootstrap_seconds)
                    await self._sample_once_unlocked()
            return self.snapshot(range_name)

    def snapshot(self, range_name: str = "15m") -> dict[str, Any]:
        try:
            window_seconds = HOST_METRIC_RANGES[range_name]
        except KeyError as error:
            raise ValueError("range must be 15m, 1h, or 24h") from error
        if not self._history:
            raise HostMetricsUnavailableError("host metrics are not available yet")

        latest = self._history[-1]
        cutoff = self._clock() - window_seconds
        selected = [sample for sample in self._history if sample.observed_at >= cutoff]
        if not selected:
            selected = [latest]
        points = self._downsample(selected)
        return {
            "hostname": latest.hostname,
            "cpuCount": latest.cpu_count,
            "sampleSeconds": self.sample_seconds,
            "collectionMode": "on-demand",
            "range": range_name,
            "latest": latest.latest_payload(),
            "history": points,
        }

    @staticmethod
    def _downsample(samples: Sequence[HostMetricSample]) -> list[dict[str, Any]]:
        chunk_size = max(1, math.ceil(len(samples) / MAX_HISTORY_POINTS))
        points: list[dict[str, Any]] = []
        for offset in range(0, len(samples), chunk_size):
            chunk = samples[offset : offset + chunk_size]
            cpu_values = [
                sample.cpu_percent
                for sample in chunk
                if sample.cpu_percent is not None
            ]
            core_count = max((len(sample.cpu_core_percents) for sample in chunk), default=0)
            core_values: list[float | None] = []
            for core_index in range(core_count):
                values: list[float] = []
                for sample in chunk:
                    if core_index >= len(sample.cpu_core_percents):
                        continue
                    value = sample.cpu_core_percents[core_index]
                    if value is not None:
                        values.append(value)
                core_values.append(
                    round(sum(values) / len(values), 2) if values else None
                )
            points.append(
                {
                    "observedAt": round(chunk[-1].observed_at, 3),
                    "cpuPercent": (
                        round(sum(cpu_values) / len(cpu_values), 2)
                        if cpu_values
                        else None
                    ),
                    "cpuCores": core_values,
                    "memoryUsedBytes": round(
                        sum(sample.memory_used_bytes for sample in chunk) / len(chunk)
                    ),
                }
            )
        return points
