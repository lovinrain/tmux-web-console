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
MAX_HISTORY_POINTS = 180


class HostMetricsUnavailableError(RuntimeError):
    pass


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


@dataclass(frozen=True)
class HostMetricSample:
    observed_at: float
    cpu_percent: float | None
    memory_total_bytes: int
    memory_used_bytes: int
    memory_available_bytes: int
    swap_total_bytes: int
    swap_used_bytes: int
    load_average: tuple[float, float, float]
    cpu_count: int
    hostname: str

    def latest_payload(self) -> dict[str, Any]:
        return {
            "observedAt": round(self.observed_at, 3),
            "cpuPercent": self.cpu_percent,
            "memoryTotalBytes": self.memory_total_bytes,
            "memoryUsedBytes": self.memory_used_bytes,
            "memoryAvailableBytes": self.memory_available_bytes,
            "swapTotalBytes": self.swap_total_bytes,
            "swapUsedBytes": self.swap_used_bytes,
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


def read_linux_host_counters(
    stat_path: Path = Path("/proc/stat"),
    meminfo_path: Path = Path("/proc/meminfo"),
) -> HostCounters:
    cpu_line = stat_path.read_text(encoding="ascii").splitlines()[0].split()
    if not cpu_line or cpu_line[0] != "cpu" or len(cpu_line) < 5:
        raise ValueError("/proc/stat does not contain aggregate CPU counters")
    try:
        cpu_values = [int(value) for value in cpu_line[1:9]]
    except ValueError as error:
        raise ValueError("/proc/stat contains invalid aggregate CPU counters") from error
    cpu_total = sum(cpu_values)
    cpu_idle = cpu_values[3] + (cpu_values[4] if len(cpu_values) > 4 else 0)

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
    try:
        load_average = tuple(float(value) for value in os.getloadavg())
    except OSError:
        load_average = (0.0, 0.0, 0.0)

    return HostCounters(
        cpu_total=cpu_total,
        cpu_idle=cpu_idle,
        memory_total_bytes=memory_total,
        memory_available_bytes=memory_available,
        swap_total_bytes=swap_total,
        swap_free_bytes=swap_free,
        load_average=(load_average[0], load_average[1], load_average[2]),
        cpu_count=os.cpu_count() or 1,
        hostname=socket.gethostname(),
    )


class HostMetricsSampler:
    def __init__(
        self,
        *,
        sample_seconds: float = DEFAULT_SAMPLE_SECONDS,
        history_seconds: float = HOST_METRIC_RANGES["24h"],
        reader: Callable[[], HostCounters] = read_linux_host_counters,
        clock: Callable[[], float] = time.time,
    ) -> None:
        if not math.isfinite(sample_seconds) or sample_seconds <= 0:
            raise ValueError("host metric sample interval must be positive")
        if not math.isfinite(history_seconds) or history_seconds <= 0:
            raise ValueError("host metric history duration must be positive")
        self.sample_seconds = sample_seconds
        self._reader = reader
        self._clock = clock
        capacity = max(2, math.ceil(history_seconds / sample_seconds) + 2)
        self._history: deque[HostMetricSample] = deque(maxlen=capacity)
        self._previous_cpu: tuple[int, int] | None = None
        self._task: asyncio.Task[None] | None = None
        self._last_error: str | None = None

    async def sample_once(self) -> HostMetricSample | None:
        try:
            counters = await asyncio.to_thread(self._reader)
        except (OSError, ValueError) as error:
            message = str(error) or type(error).__name__
            if message != self._last_error:
                LOGGER.warning("Host metrics sampling is unavailable: %s", message)
            self._last_error = message
            return None

        cpu_percent: float | None = None
        if self._previous_cpu is not None:
            previous_total, previous_idle = self._previous_cpu
            total_delta = counters.cpu_total - previous_total
            idle_delta = counters.cpu_idle - previous_idle
            if total_delta > 0 and 0 <= idle_delta <= total_delta:
                cpu_percent = round(
                    max(0.0, min(100.0, 100.0 * (total_delta - idle_delta) / total_delta)),
                    2,
                )
        self._previous_cpu = (counters.cpu_total, counters.cpu_idle)
        sample = HostMetricSample(
            observed_at=self._clock(),
            cpu_percent=cpu_percent,
            memory_total_bytes=counters.memory_total_bytes,
            memory_used_bytes=max(
                0,
                counters.memory_total_bytes - counters.memory_available_bytes,
            ),
            memory_available_bytes=counters.memory_available_bytes,
            swap_total_bytes=counters.swap_total_bytes,
            swap_used_bytes=max(
                0,
                counters.swap_total_bytes - counters.swap_free_bytes,
            ),
            load_average=counters.load_average,
            cpu_count=counters.cpu_count,
            hostname=counters.hostname,
        )
        self._history.append(sample)
        self._last_error = None
        return sample

    async def start(self) -> None:
        if self._task is not None:
            return
        await self.sample_once()
        self._task = asyncio.create_task(self._run(), name="muxdeck-host-metrics")

    async def _run(self) -> None:
        while True:
            await asyncio.sleep(self.sample_seconds)
            await self.sample_once()

    async def close(self) -> None:
        task = self._task
        self._task = None
        if task is None:
            return
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

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
            points.append(
                {
                    "observedAt": round(chunk[-1].observed_at, 3),
                    "cpuPercent": (
                        round(sum(cpu_values) / len(cpu_values), 2)
                        if cpu_values
                        else None
                    ),
                    "memoryUsedBytes": round(
                        sum(sample.memory_used_bytes for sample in chunk) / len(chunk)
                    ),
                }
            )
        return points
