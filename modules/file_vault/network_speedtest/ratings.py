"""Star-rating (1-5) thresholds for speedtest results. Each threshold is a named constant beside its function so
the planned configurability is a one-constant edit. The four scenario functions (browsing/streaming/video/gaming) follow the
requirement doc; `overall_speed`/`latency`/`stability` were unspecified, so their bands are this implementation's own defaults to retune."""

from typing import NamedTuple, Optional

# --- 上网浏览：延迟为主，下载速度在两端起门槛/加分作用 ---
_BROWSING_PING_BAD_MS = 500.0
_BROWSING_DOWNLOAD_BAD_MBPS = 1.0
_BROWSING_PING_POOR_MS = 300.0
_BROWSING_PING_FAIR_MS = 150.0
_BROWSING_PING_GOOD_MS = 50.0
_BROWSING_DOWNLOAD_GREAT_MBPS = 20.0


def rate_browsing(ping_ms: float, download_mbps: float) -> int:
    if ping_ms > _BROWSING_PING_BAD_MS or download_mbps < _BROWSING_DOWNLOAD_BAD_MBPS:
        return 1
    if ping_ms > _BROWSING_PING_POOR_MS:
        return 2
    if ping_ms > _BROWSING_PING_FAIR_MS:
        return 3
    if ping_ms > _BROWSING_PING_GOOD_MS:
        return 4
    return 5 if download_mbps > _BROWSING_DOWNLOAD_GREAT_MBPS else 4


# --- 直播（推流/观看）：上传为主，延迟在顶档加分 ---
_STREAMING_UPLOAD_POOR_MBPS = 1.0
_STREAMING_UPLOAD_FAIR_MBPS = 3.0
_STREAMING_UPLOAD_GOOD_MBPS = 5.0
_STREAMING_UPLOAD_GREAT_MBPS = 10.0
_STREAMING_PING_GREAT_MS = 50.0


def rate_streaming(ping_ms: float, upload_mbps: float) -> int:
    if upload_mbps < _STREAMING_UPLOAD_POOR_MBPS:
        return 1
    if upload_mbps < _STREAMING_UPLOAD_FAIR_MBPS:
        return 2
    if upload_mbps < _STREAMING_UPLOAD_GOOD_MBPS:
        return 3
    if upload_mbps < _STREAMING_UPLOAD_GREAT_MBPS:
        return 4
    return 5 if ping_ms < _STREAMING_PING_GREAT_MS else 4


# --- 视频观看：纯下载速度分档 ---
_VIDEO_DOWNLOAD_POOR_MBPS = 2.0
_VIDEO_DOWNLOAD_FAIR_MBPS = 5.0
_VIDEO_DOWNLOAD_GOOD_MBPS = 10.0
_VIDEO_DOWNLOAD_GREAT_MBPS = 25.0


def rate_video(download_mbps: float) -> int:
    if download_mbps < _VIDEO_DOWNLOAD_POOR_MBPS:
        return 1
    if download_mbps < _VIDEO_DOWNLOAD_FAIR_MBPS:
        return 2
    if download_mbps < _VIDEO_DOWNLOAD_GOOD_MBPS:
        return 3
    if download_mbps < _VIDEO_DOWNLOAD_GREAT_MBPS:
        return 4
    return 5


# --- 网络游戏：延迟为主，抖动/丢包在两端起门槛/加分作用 ---
_GAMING_PING_BAD_MS = 150.0
_GAMING_JITTER_BAD_MS = 30.0  # 抖动超过这个值即视为"抖动明显"
_GAMING_PING_POOR_MS = 100.0
_GAMING_PING_FAIR_MS = 50.0
_GAMING_PING_GOOD_MS = 20.0
_GAMING_LOSS_ZERO_RATIO = 0.01  # 丢包率视为"≈0"的上限
# 加压延迟比空闲延迟高出此值以上即判定缓冲膨胀明显（别人下载时打游戏卡的成因），空闲延迟再好也不给满分。
_GAMING_LOADED_PING_DELTA_BAD_MS = 100.0


def rate_gaming(ping_ms: float, jitter_ms: float, loss_ratio: float, loaded_ping_delta_ms: Optional[float] = None) -> int:
    if ping_ms > _GAMING_PING_BAD_MS or jitter_ms > _GAMING_JITTER_BAD_MS:
        return 1
    if ping_ms > _GAMING_PING_POOR_MS:
        return 2
    if ping_ms > _GAMING_PING_FAIR_MS:
        return 3
    if ping_ms > _GAMING_PING_GOOD_MS:
        return 4
    if loaded_ping_delta_ms is not None and loaded_ping_delta_ms > _GAMING_LOADED_PING_DELTA_BAD_MS:
        return 4  # 空闲延迟很好，但一跑满就暴涨，缓冲膨胀明显，封顶4星
    return 5 if loss_ratio <= _GAMING_LOSS_ZERO_RATIO else 4


# --- 综合指标：本实现自定的默认档位（需求文档未给出具体数值） ---
_SPEED_POOR_MBPS = 1.0
_SPEED_FAIR_MBPS = 5.0
_SPEED_GOOD_MBPS = 20.0
_SPEED_GREAT_MBPS = 50.0


def rate_overall_speed(download_mbps: float) -> int:
    if download_mbps < _SPEED_POOR_MBPS:
        return 1
    if download_mbps < _SPEED_FAIR_MBPS:
        return 2
    if download_mbps < _SPEED_GOOD_MBPS:
        return 3
    if download_mbps < _SPEED_GREAT_MBPS:
        return 4
    return 5


_LATENCY_POOR_MS = 300.0
_LATENCY_FAIR_MS = 150.0
_LATENCY_GOOD_MS = 80.0
_LATENCY_GREAT_MS = 30.0


def rate_latency(ping_ms: float) -> int:
    if ping_ms > _LATENCY_POOR_MS:
        return 1
    if ping_ms > _LATENCY_FAIR_MS:
        return 2
    if ping_ms > _LATENCY_GOOD_MS:
        return 3
    if ping_ms > _LATENCY_GREAT_MS:
        return 4
    return 5


_STABILITY_LOSS_POOR_RATIO = 0.05
_STABILITY_JITTER_POOR_MS = 50.0
_STABILITY_LOSS_FAIR_RATIO = 0.02
_STABILITY_JITTER_FAIR_MS = 30.0
_STABILITY_JITTER_GOOD_MS = 15.0
_STABILITY_JITTER_GREAT_MS = 5.0


def rate_stability(jitter_ms: float, loss_ratio: float) -> int:
    if loss_ratio > _STABILITY_LOSS_POOR_RATIO or jitter_ms > _STABILITY_JITTER_POOR_MS:
        return 1
    if loss_ratio > _STABILITY_LOSS_FAIR_RATIO or jitter_ms > _STABILITY_JITTER_FAIR_MS:
        return 2
    if jitter_ms > _STABILITY_JITTER_GOOD_MS:
        return 3
    if jitter_ms > _STABILITY_JITTER_GREAT_MS:
        return 4
    return 5


class Tier(NamedTuple):
    tier: str  # "poor" | "fair" | "good"
    color: str  # "red" | "yellow" | "green"


def stars_to_tier(stars: int) -> Tier:
    if stars <= 2:
        return Tier("poor", "red")
    if stars == 3:
        return Tier("fair", "yellow")
    return Tier("good", "green")


def rate_all(
    ping_ms: float,
    jitter_ms: float,
    loss_ratio: float,
    download_mbps: float,
    upload_mbps: float,
    download_loaded_ping_ms: Optional[float] = None,
    upload_loaded_ping_ms: Optional[float] = None,
) -> dict:
    # 取下载/上传两方向中加压延迟较高的与空闲延迟比较：上下行不对称线路的缓冲膨胀可能不对称，取较差者反映最坏情况；
    # 两方向都没测到（None）则不参与评级，rate_gaming 按没有这个信号处理。
    loaded_candidates = [v for v in (download_loaded_ping_ms, upload_loaded_ping_ms) if v is not None]
    loaded_ping_delta_ms = (max(loaded_candidates) - ping_ms) if loaded_candidates else None
    stars = {
        "browsing": rate_browsing(ping_ms, download_mbps),
        "streaming": rate_streaming(ping_ms, upload_mbps),
        "video": rate_video(download_mbps),
        "gaming": rate_gaming(ping_ms, jitter_ms, loss_ratio, loaded_ping_delta_ms),
        "overall_speed": rate_overall_speed(download_mbps),
        "latency": rate_latency(ping_ms),
        "stability": rate_stability(jitter_ms, loss_ratio),
    }
    return {
        key: {"stars": value, "tier": stars_to_tier(value).tier, "color": stars_to_tier(value).color}
        for key, value in stars.items()
    }
