from __future__ import annotations

import asyncio

import pytest
from aiohttp.test_utils import TestClient, TestServer

from tmux_console.app import create_app
from tmux_console.host_metrics import (
    HostCounters,
    HostMetricsSampler,
    PressureAverages,
    read_linux_host_counters,
)


def counters(
    total: int,
    idle: int,
    *,
    memory_available: int = 3_000,
    cpu_cores: tuple[tuple[int, int], ...] = (),
    pressure_some: PressureAverages | None = None,
    pressure_full: PressureAverages | None = None,
    swap_in_pages: int | None = None,
    swap_out_pages: int | None = None,
) -> HostCounters:
    return HostCounters(
        cpu_total=total,
        cpu_idle=idle,
        memory_total_bytes=8_000,
        memory_available_bytes=memory_available,
        swap_total_bytes=4_000,
        swap_free_bytes=1_500,
        load_average=(1.25, 1.5, 1.75),
        cpu_count=len(cpu_cores) or 8,
        hostname="test-host",
        cpu_cores=cpu_cores,
        memory_pressure_some=pressure_some,
        memory_pressure_full=pressure_full,
        swap_in_pages=swap_in_pages,
        swap_out_pages=swap_out_pages,
        page_size_bytes=4096,
    )


def test_reads_linux_cpu_memory_pressure_and_swap_counters(tmp_path, monkeypatch):
    stat_path = tmp_path / "stat"
    meminfo_path = tmp_path / "meminfo"
    pressure_path = tmp_path / "pressure"
    vmstat_path = tmp_path / "vmstat"
    stat_path.write_text(
        "cpu  100 5 20 800 30 2 3 4 0 0\n"
        "cpu1 20 0 10 160 10 0 0 0\n"
        "cpu0 10 0 5 80 5 0 0 0\n",
        encoding="ascii",
    )
    meminfo_path.write_text(
        "MemTotal:       32000 kB\n"
        "MemAvailable:   12000 kB\n"
        "SwapTotal:      16000 kB\n"
        "SwapFree:        6000 kB\n",
        encoding="ascii",
    )
    pressure_path.write_text(
        "some avg10=1.25 avg60=2.50 avg300=3.75 total=100\n"
        "full avg10=0.10 avg60=0.20 avg300=0.30 total=50\n",
        encoding="ascii",
    )
    vmstat_path.write_text("pgpgin 10\npswpin 42\npswpout 17\n", encoding="ascii")
    monkeypatch.setattr("tmux_console.host_metrics.os.getloadavg", lambda: (0.5, 1.0, 1.5))
    monkeypatch.setattr("tmux_console.host_metrics.os.sysconf", lambda _key: 8192)
    monkeypatch.setattr("tmux_console.host_metrics.socket.gethostname", lambda: "mux-host")

    result = read_linux_host_counters(
        stat_path,
        meminfo_path,
        pressure_path,
        vmstat_path,
    )

    assert result.cpu_total == 964
    assert result.cpu_idle == 830
    assert result.cpu_cores == ((100, 85), (200, 170))
    assert result.memory_total_bytes == 32_000 * 1024
    assert result.memory_available_bytes == 12_000 * 1024
    assert result.swap_total_bytes == 16_000 * 1024
    assert result.swap_free_bytes == 6_000 * 1024
    assert result.memory_pressure_some == PressureAverages(1.25, 2.5, 3.75)
    assert result.memory_pressure_full == PressureAverages(0.1, 0.2, 0.3)
    assert result.swap_in_pages == 42
    assert result.swap_out_pages == 17
    assert result.page_size_bytes == 8192
    assert result.load_average == (0.5, 1.0, 1.5)
    assert result.cpu_count == 2
    assert result.hostname == "mux-host"


def test_missing_linux_pressure_sources_do_not_hide_core_metrics(tmp_path):
    stat_path = tmp_path / "stat"
    meminfo_path = tmp_path / "meminfo"
    stat_path.write_text(
        "cpu 10 0 10 80\ncpu0 5 0 5 40\ncpu1 5 0 5 40\n",
        encoding="ascii",
    )
    meminfo_path.write_text("MemTotal: 1000 kB\nMemAvailable: 500 kB\n", encoding="ascii")

    result = read_linux_host_counters(
        stat_path,
        meminfo_path,
        tmp_path / "missing-pressure",
        tmp_path / "missing-vmstat",
    )

    assert result.cpu_count == 2
    assert result.memory_pressure_some is None
    assert result.memory_pressure_full is None
    assert result.swap_in_pages is None
    assert result.swap_out_pages is None


@pytest.mark.asyncio
async def test_sampler_calculates_per_core_cpu_swap_rates_and_downsamples_history():
    current = {"index": 0, "now": 1_700_000_000.0}

    def read() -> HostCounters:
        index = current["index"]
        current["index"] += 1
        return counters(
            1_000 + index * 100,
            700 + index * 20,
            cpu_cores=(
                (500 + index * 50, 350 + index * 10),
                (500 + index * 50, 350 + index * 40),
            ),
            pressure_some=PressureAverages(1.5, 1.0, 0.5),
            pressure_full=PressureAverages(0.25, 0.1, 0.05),
            swap_in_pages=100 + index * 2,
            swap_out_pages=200 + index,
        )

    sampler = HostMetricsSampler(
        sample_seconds=5,
        history_seconds=2_000,
        reader=read,
        clock=lambda: current["now"],
        monotonic=lambda: current["now"],
    )
    for _ in range(201):
        await sampler.sample_once()
        current["now"] += 5

    snapshot = sampler.snapshot("15m")

    assert snapshot["hostname"] == "test-host"
    assert snapshot["cpuCount"] == 2
    assert snapshot["collectionMode"] == "on-demand"
    assert snapshot["latest"]["cpuPercent"] == 80.0
    assert snapshot["latest"]["cpuCores"] == [80.0, 20.0]
    assert snapshot["latest"]["memoryUsedBytes"] == 5_000
    assert snapshot["latest"]["swapUsedBytes"] == 2_500
    assert snapshot["latest"]["swapInBytesPerSecond"] == 1638.4
    assert snapshot["latest"]["swapOutBytesPerSecond"] == 819.2
    assert snapshot["latest"]["memoryPressure"]["some"]["avg10"] == 1.5
    assert 1 < len(snapshot["history"]) <= 180
    assert snapshot["history"][-1]["cpuPercent"] == 80.0
    assert snapshot["history"][-1]["cpuCores"] == [80.0, 20.0]


@pytest.mark.asyncio
async def test_host_metrics_api_samples_only_on_request_and_caches_rapid_requests():
    current = {"total": 1_000, "idle": 700, "reads": 0}

    def read() -> HostCounters:
        current["reads"] += 1
        current["total"] += 100
        current["idle"] += 25
        index = current["reads"]
        return counters(
            current["total"],
            current["idle"],
            cpu_cores=((500 + index * 50, 350 + index * 10),),
        )

    sampler = HostMetricsSampler(
        sample_seconds=5,
        request_cache_seconds=10,
        bootstrap_seconds=0.001,
        reader=read,
    )
    client = TestClient(TestServer(create_app(base_path="", host_metrics=sampler)))
    await client.start_server()
    try:
        assert current["reads"] == 0

        response = await client.get("/api/host-metrics", params={"range": "1h"})
        assert response.status == 200
        payload = await response.json()
        assert payload["range"] == "1h"
        assert payload["sampleSeconds"] == 5
        assert payload["collectionMode"] == "on-demand"
        assert payload["latest"]["cpuPercent"] == 75.0
        assert payload["latest"]["cpuCores"] == [80.0]
        assert current["reads"] == 2

        cached = await client.get("/api/host-metrics")
        assert cached.status == 200
        assert current["reads"] == 2

        invalid = await client.get("/api/host-metrics", params={"range": "week"})
        assert invalid.status == 400
        assert (await invalid.json())["error"] == "range must be 15m, 1h, or 24h"

        unknown = await client.get("/api/host-metrics", params={"extra": "1"})
        assert unknown.status == 400
        assert (await unknown.json())["error"] == "unknown query field: extra"
        assert current["reads"] == 2
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_concurrent_host_metric_requests_share_the_bootstrap_sample():
    reads = 0

    def read() -> HostCounters:
        nonlocal reads
        reads += 1
        return counters(
            1_000 + reads * 100,
            700 + reads * 20,
            cpu_cores=((500 + reads * 50, 350 + reads * 10),),
        )

    sampler = HostMetricsSampler(
        request_cache_seconds=10,
        bootstrap_seconds=0.001,
        reader=read,
    )

    snapshots = await asyncio.gather(*(sampler.collect_snapshot() for _ in range(5)))

    assert reads == 2
    assert {snapshot["latest"]["observedAt"] for snapshot in snapshots}
    assert all(snapshot["latest"]["cpuPercent"] == 80.0 for snapshot in snapshots)


@pytest.mark.asyncio
async def test_host_metrics_api_reports_an_unavailable_sampler():
    reads = 0

    def unavailable() -> HostCounters:
        nonlocal reads
        reads += 1
        raise OSError("procfs is unavailable")

    client = TestClient(TestServer(create_app(
        base_path="",
        host_metrics=HostMetricsSampler(
            sample_seconds=60,
            reader=unavailable,
        ),
    )))
    await client.start_server()
    try:
        assert reads == 0
        response = await client.get("/api/host-metrics")
        assert response.status == 503
        assert (await response.json())["error"] == "host metrics are not available yet"
        assert reads == 1
    finally:
        await client.close()
