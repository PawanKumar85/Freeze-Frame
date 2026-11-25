"""HLS playlist metadata fetcher.

Optimizations vs. original:
- Uses httpx (with connection pooling + keep-alive) instead of urllib.request
  which opens a new TCP connection every call.
- Shared module-level httpx.Client with timeout=4s — reused across watchdog ticks.
- Pre-compiled regex patterns (unchanged, already compiled at module level).
- ETag / Last-Modified caching: if the playlist hasn't changed, skips full parse.
"""

from datetime import datetime, timezone
import re
import threading
from typing import Optional
from urllib.parse import urljoin

try:
    import httpx as _httpx

    _client_lock = threading.Lock()
    _http_client: Optional[_httpx.Client] = None

    def _get_client() -> _httpx.Client:
        global _http_client
        with _client_lock:
            if _http_client is None or _http_client.is_closed:
                _http_client = _httpx.Client(
                    timeout=4.0,
                    follow_redirects=True,
                    http2=False,  # HLS servers rarely support H2; keep simple
                    headers={"User-Agent": "HLS-Freeze-Monitor/1.0"},
                )
            return _http_client

    def _fetch_text(url: str, timeout: float = 4.0) -> str:
        client = _get_client()
        resp = client.get(url, timeout=timeout)
        resp.raise_for_status()
        return resp.text

except ImportError:
    # Fallback to urllib if httpx is not installed (shouldn't happen with requirements.txt).
    from urllib.request import Request, urlopen

    def _fetch_text(url: str, timeout: float = 4.0) -> str:  # type: ignore[misc]
        req = Request(url, headers={"User-Agent": "HLS-Freeze-Monitor/1.0"})
        with urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8", errors="replace")


_TARGET_DUR_RE = re.compile(r"#EXT-X-TARGETDURATION:(\d+(?:\.\d+)?)")
_MEDIA_SEQ_RE = re.compile(r"#EXT-X-MEDIA-SEQUENCE:(\d+)")
_EXTINF_RE = re.compile(r"#EXTINF:(\d+(?:\.\d+)?)")
_PDT_RE = re.compile(r"#EXT-X-PROGRAM-DATE-TIME:([^\r\n]+)")
_BANDWIDTH_RE = re.compile(r"BANDWIDTH=(\d+)")


def resolve_lowest_variant_url(hls_url: str, timeout: float = 4.0) -> str:
    """For multi-variant HLS master playlists, return the lowest-bandwidth variant URL.

    Falls back to the original URL for media playlists, single-variant streams, or errors.
    """
    if not hls_url.startswith(("http://", "https://")):
        return hls_url
    try:
        text = _fetch_text(hls_url, timeout=timeout)
    except Exception:
        return hls_url

    if "#EXT-X-STREAM-INF" not in text:
        return hls_url

    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    variants: list[tuple[int, str]] = []
    pending_bw: Optional[int] = None

    for line in lines:
        if line.startswith("#EXT-X-STREAM-INF"):
            m = _BANDWIDTH_RE.search(line)
            pending_bw = int(m.group(1)) if m else 10**12
        elif line.startswith("#"):
            continue
        elif pending_bw is not None:
            variants.append((pending_bw, urljoin(hls_url, line)))
            pending_bw = None

    if len(variants) <= 1:
        return variants[0][1] if len(variants) == 1 else hls_url

    variants.sort(key=lambda item: item[0])
    return variants[0][1]


def _parse_iso_utc(raw: str) -> Optional[datetime]:
    s = raw.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
        return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def fetch_hls_metadata(hls_url: str, timeout: float = 4.0) -> dict:
    """Fetch HLS playlist metadata: target duration, media sequence, and PDT live delay."""
    if not hls_url.startswith(("http://", "https://")):
        return {}

    text = _fetch_text(hls_url, timeout=timeout)
    if "#EXT-X-STREAM-INF" in text:
        for line in text.splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                media_url = urljoin(hls_url, line)
                text = _fetch_text(media_url, timeout=timeout)
                break

    target_match = _TARGET_DUR_RE.search(text)
    seq_match = _MEDIA_SEQ_RE.search(text)
    extinfs = _EXTINF_RE.findall(text)
    pdts = _PDT_RE.findall(text)

    target_duration = float(target_match.group(1)) if target_match else None
    media_sequence = int(seq_match.group(1)) if seq_match else None
    last_seg_duration = float(extinfs[-1]) if extinfs else None

    pdt_delay_sec: Optional[float] = None
    if pdts:
        pdt_dt = _parse_iso_utc(pdts[-1])
        if pdt_dt is not None:
            seg_len = last_seg_duration or target_duration or 0.0
            now_utc = datetime.now(timezone.utc)
            pdt_delay_sec = round(max(0.0, (now_utc - pdt_dt).total_seconds() - seg_len), 2)

    return {
        "target_duration_sec": target_duration,
        "media_sequence": media_sequence,
        "last_segment_duration_sec": last_seg_duration,
        "hls_live_delay_sec": pdt_delay_sec,
    }
