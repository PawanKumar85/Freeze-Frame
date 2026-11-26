# HLS Freeze Monitor

Real-time HLS live stream freeze, loop-glitch, and segment-delay monitoring system powered by a **zero-copy Rust + FFmpeg** video engine, **FastAPI + SSE** backend, **SQLite** persistence, and a **React + Vite** dashboard.

---

## Features

- **4-Algorithm Rust Detection (`rust_frame_reader`):**
  1. **MAE** (`≤ 0.6`)
  2. **Motion Pixel Ratio** (`|Δ| > 4`, `≤ 0.8%`)
  3. **2D Prefix-Sum SSIM** (`≥ 0.997`)
  4. **64-bit dHash + 32×18 Thumbnail MAE** ping-pong/loop freeze detector
- **Hybrid Decode Engine (`Auto` | `CPU` | `GPU`):**
  - Auto-detects hardware acceleration (`VideoToolbox` on macOS; `CUDA` / `VAAPI` / `QSV` / `DRM` on Linux) and falls back cleanly to optimized software CPU decoding (`AVDISCARD_NONREF`, `skip_loop_filter=ALL`, `AV_CODEC_FLAG2_FAST`, `FAST_BILINEAR`).
- **Dynamic ROI & Per-Zone Grid Alerts:**
  - Drag/resize ROI overlay with **`2×2`**, **`3×3`**, **`4×4`**, and **`5×5`** grids and live per-cell `OK / STATIC / FREEZE` badges.
- **HLS Watchdog & Timeout Alerts:**
  - Polls playlist metadata (`#EXT-X-TARGETDURATION`, `#EXT-X-MEDIA-SEQUENCE`, `#EXT-X-PROGRAM-DATE-TIME`), auto-selects the lowest-resolution variant on multi-bitrate master playlists, and detects `SEGMENT_DELAY` and `SEGMENT_DOWNLOAD_TIMEOUT`.
- **Eco CPU Mode & Bandwidth Controls:**
  - `Eco CPU Mode` (`1.0 FPS`, `160×90` downscale) + `Pause / Resume Preview` toggle.
- **Real-Time Telemetry & SQLite Persistence (`/history`):**
  - Live 2s `/proc` CPU %, RAM, and RX/TX bandwidth telemetry, batched SQLite logging (`freeze_logs.db` with bitmask `zone_mask`), History & Analytics view, and CSV export.

---

## Project Structure

```text
Freeze/
├── docker-compose.yml          # Container config (0.50 vCPU, 256 MiB cap, ./backend/data volume)
├── Dockerfile                  # Multi-stage build (Node 20 + Rust/Maturin + Python 3.11)
├── docs/
│   ├── HLS.tldr                # Excalidraw/tldraw architecture diagram
│   ├── system.md               # Benchmarks, k6 CPU vs GPU results, 12-vCPU capacity guide
│   └── future.md               # Planned features (Green Screen, Glitch, Multi-Channel)
├── backend/
│   ├── server.py               # FastAPI + asyncio SSE + Watchdog + Telemetry + GZip
│   ├── main.py                 # CLI runner
│   ├── requirements.txt
│   ├── detector/
│   │   ├── hls_metadata.py     # Playlist polling, lowest-variant selection, segment probe
│   │   ├── log_store.py        # Batched SQLite store (alert_logs + metric_logs + CSV)
│   │   ├── native_monitor.py   # Rust runner + burst decode pacing
│   │   ├── protocols.py
│   │   └── state_machine.py    # Freeze confirmation & PTS discontinuity reset
│   └── models/
│       ├── state.py
│       ├── stream.py
│       └── zone.py
├── rust_frame_reader/          # PyO3 + FFmpeg native extension crate
│   ├── Cargo.toml
│   ├── pyproject.toml
│   └── src/lib.rs
└── frontend/                   # React 19 + Vite + Tailwind v4 + Untitled UI
    ├── vite.config.js
    └── src/
        ├── App.jsx             # Monitor dashboard & live ROI grid
        └── components/
            ├── hld/HldFlow.jsx # High-level architecture view (/hld)
            └── history/HistoryView.jsx # Logs & analytics view (/history)
```

---

## Quick Start (Docker Compose)

```bash
docker compose up -d --build
```

Open:
- **Monitor UI:** `http://localhost:8000`
- **History & Analytics:** `http://localhost:8000/history`
- **HLD Architecture:** `http://localhost:8000/hld`

Persistent logs are stored on the host at `backend/data/freeze_logs.db`.

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/start` | Start monitoring (`hls_url`, `sample_fps`, `alert_after_sec`, `grid_size`, `eco_mode`, `decode_mode`, ROI) |
| `POST` | `/api/stop` | Stop active monitor |
| `GET` | `/api/status` | Current session config, `active_decoder`, and HLS metadata |
| `GET` | `/api/events` | Real-time SSE stream (`status`, `frame`, `alert`, `error_msg`, `sys_stats`) |
| `GET` | `/api/logs` | Recent alert & session logs from SQLite |
| `GET` | `/api/metrics` | Recent sampled frame + telemetry rows |
| `GET` | `/api/metrics/export` | Download `freeze_metrics.csv` |
| `DELETE` | `/api/logs` | Clear saved SQLite logs & metrics |

---

## Docs
- [System Benchmarks & Capacity Guide](docs/system.md)
- [Future Roadmap](docs/future.md)
