# System Design, Benchmarks & Capacity Guide — HLS Freeze Monitor

---

## 1. Architecture & Container Spec
- **Runtime:** Multi-stage Docker (`node:20-slim` + `python:3.11-slim-trixie` + `libav*` + compiled `rust_frame_reader` wheel)
- **Image Size:** `~874 MB`
- **Single-Stream Caps (`docker-compose.yml`):** `cpus: 0.50`, `mem_limit: 256m`, `MALLOC_ARENA_MAX=2`
- **Process Model:** `uvicorn[standard]` (`uvloop` + `httptools`) + GIL-free Rust/FFmpeg worker (`count=1` frame decoder) + 2s Watchdog + SQLite (`TRUNCATE`, batched 10 rows / 10s, bitmask `zone_mask`)
- **HTTP Compression:** Selective GZip on `/api/metrics`, `/api/logs`, `/api/metrics/export` (SSE `/api/events` unbuffered)

---

## 2. Observed Single-Stream Benchmarks (720p @ 30 FPS, ~12 Mbps)
| Metric | Idle | Active Stream Avg (`1.0 FPS`) | Peak Observed |
|---|---|---|---|
| **CPU (Docker Software Decode)** | `~0.4%` | **7.57%** (`~0.08 vCPU`) | **19.5%** (`~0.20 vCPU`) |
| **RAM (RSS)** | `~40 MiB` | **134.1 MiB** | **154.0 MiB** |
| **Download (RX)** | `0 Mbps` | **11.88 Mbps** | `77.95 Mbps` *(segment burst)* |
| **Upload (TX SSE)** | `0 KB/s` | **7.1 KB/s** (`0.057 Mbps`) | — |

### Grafana `k6` Load Test (50 VUs, 20s, Active `1.0 FPS · 3×3` Stream)
| Mode | Active Decoder | CPU % | RAM | Req/s | Avg Latency | p95 Latency | Failures |
|---|---|---|---|---|---|---|---|
| **Docker CPU (Linux VM)** | `cpu` | `13.33%` | `89.64 MiB` | `455.1/s` | `7.74 ms` | `28.15 ms` | `0.00%` |
| **Native Apple M4 GPU** | `gpu:videotoolbox` | **`2.30%`** | **`67.25 MiB`** | **`498.2/s`** | **`2.79 ms`** | **`8.24 ms`** | `0.00%` |

---

## 3. Capacity Sizing — 12 vCPU VPS (80% Safe Utilization = 9.6 vCPUs)

| Stream Profile | CPU / Stream | RAM / Stream | RX Bandwidth / Stream | **12 vCPU Capacity** | Primary Bottleneck |
|---|---|---|---|---|---|
| **360p / Low Variant** | `~0.03–0.05 vCPU` | `~90 MiB` | `~1.5–2.5 Mbps` | **180 – 220 streams** | CPU |
| **720p @ 30 FPS** | `~0.08–0.12 vCPU` *(peak 0.20)* | `~135–155 MiB` | `~12 Mbps` | **60 – 80 streams** | **Network NIC** |
| **1080p @ 30–60 FPS** | `~0.20–0.35 vCPU` | `~200 MiB` | `~20–25 Mbps` | **25 – 35 streams** | CPU + NIC |

### Network & Transfer Limits (720p @ 12 Mbps)
- **100 Mbps NIC:** max `7–8` streams
- **500 Mbps NIC:** max `35–40` streams
- **1 Gbps NIC (~800 Mbps usable):** max **`~65` streams**
- **Monthly Data Transfer (24×7):** `~3.8 TB/month` per 720p stream (`~228 TB/month` for 60 streams → unmetered port required)

### RAM & Storage Scaling
- **Separate Containers (60 × 720p):** `60 × 150 MiB` ≈ `9 GB` → **16 GB RAM VPS** recommended.
- **Multi-Channel Worker (60 × 720p):** Shared Python runtime saves `~40 MiB/stream` → `~5.5–6.5 GB` RAM.
- **Database Volume (`1.0 FPS`, Bitmask):** `~7–8 MB/day` per stream (`~450 MB/day` for 60 streams).
- **Recommended VPS Spec for 55–65 HD Streams:** **12 vCPU + 16 GB RAM + 1 Gbps Unmetered NIC**.
- **Scaling Note:** Current `MonitorManager` runs 1 active stream per container; 10+ concurrent streams should upgrade `MonitorManager` to multi-channel and switch from SQLite to PostgreSQL.
