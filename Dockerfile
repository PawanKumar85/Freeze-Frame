FROM node:20-slim AS frontend-builder

WORKDIR /frontend
COPY frontend/package.json ./
RUN npm install --no-audit --no-fund
COPY frontend ./
RUN npm run build

FROM python:3.11-slim-trixie AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    clang \
    curl \
    pkg-config \
    libavcodec-dev \
    libavdevice-dev \
    libavfilter-dev \
    libavformat-dev \
    libavutil-dev \
    libswresample-dev \
    libswscale-dev \
    && rm -rf /var/lib/apt/lists/*

ENV CARGO_HOME=/root/.cargo \
    RUSTUP_HOME=/root/.rustup \
    PATH="/root/.cargo/bin:${PATH}"

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal \
    && pip install --no-cache-dir "maturin[patchelf]>=1.5,<2.0"

WORKDIR /build
COPY rust_frame_reader ./rust_frame_reader
RUN maturin build --manifest-path rust_frame_reader/Cargo.toml --release --auditwheel=skip --out /wheels

FROM python:3.11-slim-trixie

RUN apt-get update && apt-get install -y --no-install-recommends \
    libavcodec61 \
    libavdevice61 \
    libavfilter10 \
    libavformat61 \
    libavutil59 \
    libswresample5 \
    libswscale8 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY backend/requirements.txt ./backend/requirements.txt
COPY --from=builder /wheels/*.whl /wheels/
RUN pip install --no-cache-dir -r backend/requirements.txt /wheels/*.whl && rm -rf /wheels

COPY backend ./backend
COPY --from=frontend-builder /frontend/dist ./frontend/dist

WORKDIR /app/backend
ENV HOST=0.0.0.0 PORT=8000 MALLOC_ARENA_MAX=2
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/status', timeout=3)" || exit 1

CMD ["python3", "server.py"]
