from __future__ import annotations

import pytest
from aiohttp.test_utils import TestClient, TestServer

from tmux_console.app import create_app
from tmux_console.host_metrics import (
    HostCounters,
    HostMetricsSampler,
    read_linux_host_counters,
)


def counters(
    total: int,
    idle: int,
    *,
    memory_available: int = 3_000,
) -> HostCounters:
    return HostCounters(
        cpu_total=total,
        cpu_idle=idle,
        memory_total_bytes=8_000,
        memory_available_bytes=memory_available,
        swap_total_bytes=4_000,
        swap_free_bytes=1_500,
        load_average=(1.25, 1.5, 1.75),
        cpu_count=8,
        hostname="test-host",
    )


def test_reads_linux_cpu_and_memory_counters(tmp_path, monkeypatch):
    stat_path = tmp_path / "stat"
    meminfo_path = tmp_path / "meminfo"
    stat_path.write_text(
        "cpu  100 5 20 800 30 2 3 4 0 0\ncpu0 1 2 3 4\n",
        encoding="ascii",
    )
    meminfo_path.write_text(
        "MemTotal:       32000 kB\n"
        "MemAvailable:   12000 kB\n"
        "SwapTotal:      16000 kB\n"
        "SwapFree:        6000 kB\n",
        encoding="ascii",
    )
    monkeypatch.setattr("tmux_console.host_metrics.os.getloadavg", lambda: (0.5, 1.0, 1.5))
    monkeypatch.setattr("tmux_console.host_metrics.os.cpu_count", lambda: 4)
    monkeypatch.setattr("tmux_console.host_metrics.socket.gethostname", lambda: "mux-host")

    result = read_linux_host_counters(stat_path, meminfo_path)

    assert result.cpu_total == 964
    assert result.cpu_idle == 830
    assert result.memory_total_bytes == 32_000 * 1024
    assert result.memory_available_bytes == 12_000 * 1024
    assert result.swap_total_bytes == 16_000 * 1024
    assert result.swap_free_bytes == 6_000 * 1024
    assert result.load_average == (0.5, 1.0, 1.5)
    assert result.cpu_count == 4
    assert result.hostname == "mux-host"


@pytest.mark.asyncio
async def test_sampler_calculates_cpu_deltas_and_downsamples_history():
    current = {"index": 0, "now": 1_700_000_000.0}

    def read() -> HostCounters:
        index = current["index"]
        current["index"] += 1
        return counters(1_000 + index * 100, 700 + index * 20)

    sampler = HostMetricsSampler(
        sample_seconds=5,
        history_seconds=2_000,
        reader=read,
        clock=lambda: current["now"],
    )
    for _ in range(201):
        await sampler.sample_once()
        current["now"] += 5

    snapshot = sampler.snapshot("15m")

    assert snapshot["hostname"] == "test-host"
    assert snapshot["cpuCount"] == 8
    assert snapshot["latest"]["cpuPercent"] == 80.0
    assert snapshot["latest"]["memoryUsedBytes"] == 5_000
    assert snapshot["latest"]["swapUsedBytes"] == 2_500
    assert 1 < len(snapshot["history"]) <= 180
    assert snapshot["history"][-1]["cpuPercent"] == 80.0


@pytest.mark.asyncio
async def test_host_metrics_api_serves_cached_samples_and_validates_range():
    current = {"total": 1_000, "idle": 700}

    def read() -> HostCounters:
        current["total"] += 100
        current["idle"] += 25
        return counters(current["total"], current["idle"])

    sampler = HostMetricsSampler(sample_seconds=60, reader=read)
    client = TestClient(TestServer(create_app(
        base_path="",
        host_metrics=sampler,
    )))
    await client.start_server()
    try:
        await sampler.sample_once()
        response = await client.get("/api/host-metrics", params={"range": "1h"})
        assert response.status == 200
        payload = await response.json()
        assert payload["range"] == "1h"
        assert payload["sampleSeconds"] == 60
        assert payload["latest"]["cpuPercent"] == 75.0

        invalid = await client.get("/api/host-metrics", params={"range": "week"})
        assert invalid.status == 400
        assert (await invalid.json())["error"] == "range must be 15m, 1h, or 24h"

        unknown = await client.get("/api/host-metrics", params={"extra": "1"})
        assert unknown.status == 400
        assert (await unknown.json())["error"] == "unknown query field: extra"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_host_metrics_api_reports_an_unavailable_sampler():
    def unavailable() -> HostCounters:
        raise OSError("procfs is unavailable")

    client = TestClient(TestServer(create_app(
        base_path="",
        host_metrics=HostMetricsSampler(sample_seconds=60, reader=unavailable),
    )))
    await client.start_server()
    try:
        response = await client.get("/api/host-metrics")
        assert response.status == 503
        assert (await response.json())["error"] == "host metrics are not available yet"
    finally:
        await client.close()
