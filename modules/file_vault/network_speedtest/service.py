"""Runs the speedtest (latency, download, upload) against Cloudflare's public backend (speed.cloudflare.com) over a direct connection;
proxy/VPN testing was removed along with detector.py.

Ping is HTTP round-trip, not ICMP, so latency and throughput describe the same path.
Download/upload run under a hard wall-clock cutoff and compute Mbps from bytes actually transferred, keeping a test to ~5-10s even on slow lines.
Modes: a single TCP stream is capped by the bandwidth-delay product, so "multi" runs _MULTI_CONNECTION_COUNT concurrent streams and sums
bytes (socket I/O releases the GIL, so it is real concurrency). A background thread samples "loaded" ping during transfers; its gap to idle
ping is the bufferbloat signal (see _measure_loaded_ping)."""

import socket
import statistics
import threading
import time
from dataclasses import dataclass
from typing import Callable, List, Optional

import requests
from requests.adapters import HTTPAdapter


NODE_LABEL = "Cloudflare 全球测速节点 (speed.cloudflare.com)"

# 问 Cloudflare 这次实际落到哪个机房：anycast 下不同网络被路由到不同边缘节点，节点远近直接决定测速结果，
# 显示出来才能解释「今天为何比昨天慢」。返回三字母 IATA 码（如 HKG），`/cdn-cgi/trace` 是纯文本 `key=value` 行。
# 拿不到就退回通用标签：仅用于显示，绝不能影响测速本身。
_TRACE_URL = "https://speed.cloudflare.com/cdn-cgi/trace"
_TRACE_TIMEOUT_S = 2.5


def _detect_edge_node(session: requests.Session) -> Optional[str]:
    try:
        resp = session.get(_TRACE_URL, timeout=_TRACE_TIMEOUT_S)
        resp.raise_for_status()
        for line in resp.text.splitlines():
            key, sep, value = line.partition("=")
            if sep and key.strip() == "colo" and value.strip():
                return value.strip()
    except (requests.RequestException, ValueError):
        pass
    return None
_SPEEDTEST_HOSTNAME = "speed.cloudflare.com"
_DNS_TIMEOUT_S = 2.5

_PING_URL = "https://speed.cloudflare.com/__down?bytes=0"
_DOWNLOAD_URL = "https://speed.cloudflare.com/__down?bytes={size}"
_UPLOAD_URL = "https://speed.cloudflare.com/__up"

# 用 ipify 按协议固定的子域名，而非 api.ipify.org：后者按系统偏好选族，会用 v4 应答掩盖「这条路没有 IPv6」。
# 与测速共用同一 session，报出的地址即吞吐实际经过的地址。
_IPV4_URL = "https://api4.ipify.org?format=json"
_IPV6_URL = "https://api6.ipify.org?format=json"
_IP_LOOKUP_TIMEOUT_S = 2.5

# 延迟采样数，从 4 提到 16：4 个样本的中位数和抖动基本是噪声，一次 GC 或 Wi-Fi 重传就能造出离群值；16 个样本总耗时仍约 1 秒。
_PING_SAMPLE_COUNT = 16
_PING_TIMEOUT_S = 1.5
# 两次延迟采样之间的间隔。连着不停地测会一直命中同一个已经"热"的路径队列，
# 测出来的抖动系统性偏小；隔开一点才采得到真实的排队波动。
_PING_INTERVAL_S = 0.05

# 单次下载请求字节数，不能往大填：Cloudflare `__down` 对 bytes 有上限，超过回 HTTP 403
# （实测 90 MB 200 OK，100 MB 403；原来的 200 MB 让所有测速都 403 并被误报为网络不可达）。
# 现取远低于上限的值，配合 _download_from_url 的续请求循环：读完一份时间窗未到就再要一份，
# 服务端上限再变也不会打死功能，快线路也不会提前结束。
_DOWNLOAD_REQUEST_SIZE_BYTES = 25_000_000
_DOWNLOAD_MAX_DURATION_S = 10.0
_DOWNLOAD_CHUNK_SIZE = 65536
_DOWNLOAD_REQUEST_TIMEOUT_S = _DOWNLOAD_MAX_DURATION_S + 4.0

_UPLOAD_SIZE_BYTES = 120_000_000
_UPLOAD_MAX_DURATION_S = 8.0
_UPLOAD_CHUNK_SIZE = 262144
_UPLOAD_REQUEST_TIMEOUT_S = _UPLOAD_MAX_DURATION_S + 4.0

# 预热窗口：这段时间传的字节不计入速度。DNS、TCP/TLS 握手以及 TCP 慢启动（拥塞窗口要几个 RTT 才涨满）
# 会把速率拉低，窗口越短越明显；Ookla 的做法也是丢掉爬坡段只统计稳态。
# 2 秒是权衡：跨境链路 RTT 大，1 秒常未到稳态，再长则测试太久。
_DOWNLOAD_WARMUP_S = 2.0
_UPLOAD_WARMUP_S = 1.5

# 下载/上传阶段内回报「目前为止」速度的间隔：这是实时看网速变化功能本身，不是节流优化。
_TICK_INTERVAL_S = 0.2

# 多连接并发数，从 4 提到 12：单流吞吐被 `拥塞窗口 / RTT` 卡住，跨境链路吃不满带宽。
# Ookla 用到 16 条，12 已压平曲线又不至于让开销翻太多。
_MULTI_CONNECTION_COUNT = 12

# 加压延迟采样间隔：下载/上传跑满时另开连接测延迟，间隔不能太密，避免采样连接本身占带宽干扰吞吐测量。
_LOADED_PING_INTERVAL_S = 0.3

# 并发流错峰启动间隔：12 条流同一毫秒发 SYN + ClientHello 在 CDN 看来像突发攻击；
# 错开几十毫秒不影响测量（预热窗口本就有一两秒），可降低触发限流概率。
_STREAM_STAGGER_S = 0.04

# 撞上限流（HTTP 429）后这条流等多久再试。实测连续几轮多流测速后 Cloudflare 对该 IP 回 429，
# 旧代码收到 4xx 就让流退出，12 条流全退、零字节，报「服务器拒绝」；退避重试让它缓过来，实在不行才如实报错。
_RATE_LIMIT_BACKOFF_S = 0.5
_RATE_LIMIT_STATUS = 429

# 计时用 perf_counter 而非 monotonic（Windows 实测）：
#   time.monotonic()    -> GetTickCount64()          分辨率 15.625 ms
#   time.perf_counter() -> QueryPerformanceCounter() 分辨率 0.0001 ms
# monotonic 下 8ms 的往返只能读成 0 或 15.6，延迟/抖动/DNS 全是 0、15、16 的时钟刻度；
# 吞吐的 0.25 秒桶也有约 6% 误差。perf_counter 不保证跨休眠单调，但一次测速仅十几秒，无影响。
def _clock() -> float:
    return time.perf_counter()


PhaseCallback = Optional[Callable[[str, dict], None]]
TickCallback = Optional[Callable[[float], None]]
ConnectionMode = str  # "single" | "multi"


class NetworkUnreachableError(Exception):
    """Raised when not even the ping phase gets a reply; backend_server.py turns it into a VaultError ("couldn't reach the network").

    `phase` 标明是哪一步断的：ping 通而只有下载失败时，笼统的「无法连接到网络」会让用户白查网线。"""

    def __init__(self, phase: str = "network"):
        super().__init__(phase)
        self.phase = phase


class SpeedTestServerError(Exception):
    """测速服务器应答了但拒绝本次请求（HTTP 4xx/5xx）。必须与「连不上网」分开报：问题在测速源，
    用户改网络设置修不好；此类型用来杜绝 403 被显示成网络不可达。"""

    def __init__(self, phase: str, status: int):
        super().__init__(f"{phase}: HTTP {status}")
        self.phase = phase
        self.status = status


@dataclass
class SpeedTestResult:
    ping_ms: float
    jitter_ms: float
    loss_ratio: float
    dns_ms: Optional[float]
    download_mbps: float
    upload_mbps: float
    node_label: str
    ipv4: Optional[str]
    ipv6: Optional[str]
    # 有默认值，放在字段列表最后——旧的调用/测试代码（不知道这几个新字段）
    # 仍然能照常构造这个dataclass，不用跟着这次改动。
    connection_mode: str = "single"
    ping_min_ms: Optional[float] = None
    ping_max_ms: Optional[float] = None
    # 这次实际落到的 Cloudflare 边缘机房（IATA 码，如 HKG）。anycast 决定去哪儿，
    # 而去哪儿直接决定能测到多少——不显示出来，用户没法判断"今天为什么比昨天慢"。
    edge_node: Optional[str] = None
    # 这次用的测量参数。数字要能被解释：同一条线路用 1 条流测 4 秒和用 12 条流
    # 测 10 秒，结果可以差一倍，而界面上原来完全看不出用的是哪一套。
    stream_count: int = 1
    measured_seconds: float = 0.0
    # 下载/上传阶段"跑满"时测到的加压延迟中位数；该阶段一个有效样本都没
    # 采到时是None，跟其它"没测到"字段同样的处理，不是0也不是测速失败。
    download_loaded_ping_ms: Optional[float] = None
    upload_loaded_ping_ms: Optional[float] = None
    # 稳态段 p90/p10，解释「每次测的数为什么不一样」：1.2 表示线路稳、复测应接近；4.0 表示本就在四倍范围里晃，
    # 复测差一倍是线路性质而非测量出错。桶数不够（线路极慢或测试被中断）时为 None，按没测到处理。
    download_stability: Optional[float] = None
    upload_stability: Optional[float] = None


def _measure_dns(hostname: str) -> Optional[float]:
    """DNS 解析耗时：只测域名解析成 IP 这一步，用系统 DNS，与代理无关。解析失败返回 None，
    与 jitter/loss 一样按没量到处理，不算整个测速失败。getaddrinfo 不接受超时参数，
    故临时用 setdefaulttimeout 并在 finally 还原，不影响调用方后续网络操作的超时。"""
    previous_timeout = socket.getdefaulttimeout()
    socket.setdefaulttimeout(_DNS_TIMEOUT_S)
    try:
        start = _clock()
        socket.getaddrinfo(hostname, 443)
        return (_clock() - start) * 1000
    except OSError:
        return None
    finally:
        socket.setdefaulttimeout(previous_timeout)


def _build_session() -> requests.Session:
    session = requests.Session()
    # 关闭 trust_env 并清空 proxies：测的必须是直连。否则 requests 会自动采纳系统代理 / HTTP_PROXY，
    # 数字看着正常却不是本机直连链路。
    session.trust_env = False
    session.proxies = {}
    # 连接池要容纳多连接模式的 N 条并发流加加压延迟的 1 条采样连接，否则并发请求在池里排队而退化成非并发；
    # 单连接模式共用同一 session/adapter，池大无副作用。
    adapter = HTTPAdapter(pool_connections=1, pool_maxsize=_MULTI_CONNECTION_COUNT + 2)
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    return session


def _lookup_ip(session: requests.Session, url: str) -> Optional[str]:
    """None means "this path has no address of this family" (e.g. no IPv6 route): a normal outcome, never raises NetworkUnreachableError like ping/download/upload."""
    try:
        resp = session.get(url, timeout=_IP_LOOKUP_TIMEOUT_S)
        resp.raise_for_status()
        return resp.json().get("ip")
    except (requests.RequestException, ValueError):
        return None


def _measure_ip_addresses(session: requests.Session) -> tuple:
    return _lookup_ip(session, _IPV4_URL), _lookup_ip(session, _IPV6_URL)


def _tcp_rtt_ms(address: tuple, family: int) -> Optional[float]:
    """一次 TCP 连接建立的往返时间（毫秒），连不上返回 None。

    不用 HTTPS GET：那会把 TLS 加解密、HTTP 解析、服务端处理时间算进延迟，系统性抬高并把服务端抖动算到用户网络头上。
    TCP connect 只有 SYN → SYN-ACK 一个往返，是 HTTP 层能拿到的最接近真实 RTT 的量；不用 ICMP 是因为 Windows 原始套接字需要管理员权限。
    """
    sock = socket.socket(family, socket.SOCK_STREAM)
    sock.settimeout(_PING_TIMEOUT_S)
    try:
        start = _clock()
        sock.connect(address)
        return (_clock() - start) * 1000
    except OSError:
        return None
    finally:
        sock.close()


def _measure_ping(session: requests.Session) -> tuple:
    """空闲延迟 / 抖动 / 连接失败率。地址只解析一次，每个样本直连该地址，否则会把已单独测过的 DNS 重复计入延迟。"""
    try:
        info = socket.getaddrinfo(_SPEEDTEST_HOSTNAME, 443, proto=socket.IPPROTO_TCP)[0]
    except OSError as exc:
        raise NetworkUnreachableError("ping") from exc
    family, address = info[0], info[4]

    samples: List[float] = []
    failures = 0
    for index in range(_PING_SAMPLE_COUNT):
        if index:
            time.sleep(_PING_INTERVAL_S)
        rtt = _tcp_rtt_ms(address, family)
        if rtt is None:
            failures += 1
        else:
            samples.append(rtt)
    if not samples:
        raise NetworkUnreachableError("ping")
    ping_ms = statistics.median(samples)
    jitter_ms = _jitter_of(samples)
    loss_ratio = failures / _PING_SAMPLE_COUNT
    return ping_ms, jitter_ms, loss_ratio, min(samples), max(samples)


def _jitter_of(samples: List[float]) -> float:
    """相邻样本差值绝对值的平均（RFC 3550 口径），不是总体标准差。
    抖动衡量相邻两包之间跳多少：延迟从 20ms 平稳爬到 80ms 标准差大但无害，40/60 来回跳标准差可能更小却体验差；
    用标准差会与网页测速对不上。"""
    if len(samples) < 2:
        return 0.0
    return statistics.fmean(abs(b - a) for a, b in zip(samples, samples[1:]))


def _measure_loaded_ping(session: requests.Session, stop_event: threading.Event) -> List[float]:
    """下载/上传跑满期间，用同一 session 另开连接持续采样延迟，直到 stop_event 收尾；样本中位数即该阶段的加压延迟，
    与空闲 ping_ms 对比，涨得越多缓冲膨胀越明显。单次采样失败不中断只是不计入；一个都没采到返回空列表，调用方按没测到处理。"""
    samples: List[float] = []
    # 必须与空闲延迟用同一种探测方式（TCP connect），否则两数不可比：相减的差里有一大截是测法本身的差，与缓冲膨胀无关。
    try:
        info = socket.getaddrinfo(_SPEEDTEST_HOSTNAME, 443, proto=socket.IPPROTO_TCP)[0]
    except OSError:
        return samples
    family, address = info[0], info[4]
    while not stop_event.is_set():
        rtt = _tcp_rtt_ms(address, family)
        if rtt is not None:
            samples.append(rtt)
        stop_event.wait(_LOADED_PING_INTERVAL_S)
    return samples


def _run_with_loaded_ping(session: requests.Session, measure_fn: Callable[[], "_ThroughputSampler"]) -> tuple:
    """在 measure_fn()（下载或上传，单流或多流）运行期间另开线程并发采样加压延迟，measure_fn 一返回立即停止采样，
    把测量结果和延迟样本一起交回。"""
    stop_event = threading.Event()
    samples: List[float] = []

    def ping_worker() -> None:
        samples.extend(_measure_loaded_ping(session, stop_event))

    ping_thread = threading.Thread(target=ping_worker, daemon=True)
    ping_thread.start()
    try:
        result = measure_fn()
    finally:
        stop_event.set()
        ping_thread.join(timeout=_PING_TIMEOUT_S + 1.0)
    return result, samples


# 预热期不报数：跨过预热线的第一个 tick 手里还没有 measured 字节，报出去就是
# 一个刺眼的 0，实时读数会先闪一下 0 再跳到真实速度。等真有量再说。
def _mbps(measured_bytes: int, elapsed_s: float) -> float:
    """字节数 + 秒 → Mbps。分母兜个下限，避免预热窗口刚跨过就除以 0。"""
    return (measured_bytes * 8 / 1_000_000) / max(elapsed_s, 0.001)


# 不再用「总字节 ÷ 总时间」做最终读数（实测）：同线路同代码 12 流 10 秒，整段平均 26.4、稳态中位 35、
# 最快 25% 桶均值 51、峰值 56 Mbps；相隔几分钟两次整段平均为 13.3 和 26.4，差一倍。
# 即整段平均既只有真实能力的一半，又在两次间波动一倍，根子是稳态段本身抖得厉害（桶间波动 14×），
# 平均得到的是「平均多少」而非网页测速回答的「能跑多快」。
# 改为按固定时间分桶取稳态段 p90（Cloudflare 的 speed.cloudflare.com 也按百分位报）：爬坡段自然排除、
# 单次抖动/丢包的深坑不拉低整体、两次测量差异大幅收敛。
_SAMPLE_BUCKET_S = 0.25
_SPEED_PERCENTILE = 0.90
# 桶太少时百分位没有意义（3 个桶的 p90 就是最大值，等于只信一个瞬间）。
# 少于这个数就退回"总字节 ÷ 到最后一个字节为止的时间"这个老口径。
_MIN_BUCKETS_FOR_PERCENTILE = 8


def _percentile(sorted_values: List[float], q: float) -> float:
    """已排序序列的百分位（最近秩法）。空序列由调用方保证不会传进来。"""
    if len(sorted_values) == 1:
        return sorted_values[0]
    index = int(round(q * (len(sorted_values) - 1)))
    return sorted_values[min(max(index, 0), len(sorted_values) - 1)]


class _ThroughputSampler:
    """线程安全的分桶吞吐采样器，下载/上传、单流/多流四条路共用。
    只有完整的桶参与统计：窗口两端被切掉一半的桶按整桶时长去除会得到凭空减半的速率，落在高位就成假峰值，
    故首尾各去掉一个不完整的桶。"""

    def __init__(self, warmup_s: float) -> None:
        self.start = _clock()
        self.measure_from = self.start + warmup_s
        self._buckets: dict = {}
        self._lock = threading.Lock()
        self.total_bytes = 0
        self.measured_bytes = 0
        self.measured_start: Optional[float] = None
        # 最后一个字节到达的时刻，终值分母用它而非函数返回时刻：两者之间是线程 join、连接收尾等不传数据的时间，算进去会白白拉低速度。
        self.last_byte_at: Optional[float] = None

    def add(self, n: int, now: float) -> None:
        with self._lock:
            self.total_bytes += n
            self.last_byte_at = now
            if now < self.measure_from:
                return
            if self.measured_start is None:
                # 跨过预热线的第一个块只用来钉住计时起点，自己不计入：计入等于宣称它在零秒内传完，
                # 而它的字节是在此刻之前陆续到的，那段时间不在分母里；块越大线路越慢高估越离谱。
                self.measured_start = now
                return
            self.measured_bytes += n
            index = int((now - self.start) / _SAMPLE_BUCKET_S)
            self._buckets[index] = self._buckets.get(index, 0) + n

    def live_mbps(self, now: float) -> Optional[float]:
        """实时读数（喂给 on_tick）。用累计口径而不是 p90：跳动的实时数字看着
        像坏了，用户要的是一个稳稳往上爬的数。终值才用 p90。"""
        with self._lock:
            if not self.measured_bytes or self.measured_start is None:
                return None
            return _mbps(self.measured_bytes, now - self.measured_start)

    def final_mbps(self) -> float:
        with self._lock:
            if not self.measured_bytes or self.measured_start is None or self.last_byte_at is None:
                return 0.0
            complete = [
                count
                for index, count in self._buckets.items()
                if self.start + index * _SAMPLE_BUCKET_S >= self.measure_from
                and self.start + (index + 1) * _SAMPLE_BUCKET_S <= self.last_byte_at
            ]
            if len(complete) >= _MIN_BUCKETS_FOR_PERCENTILE:
                rates = sorted(count * 8 / 1_000_000 / _SAMPLE_BUCKET_S for count in complete)
                return _percentile(rates, _SPEED_PERCENTILE)
            return _mbps(self.measured_bytes, self.last_byte_at - self.measured_start)

    def stability_ratio(self) -> Optional[float]:
        """稳态段 p90 / p10，1.0 表示纹丝不动，越大越抖。单独报出以解释「每次测的数为何不同」，否则用户只会认为测速不准。"""
        with self._lock:
            complete = [
                count
                for index, count in self._buckets.items()
                if self.start + index * _SAMPLE_BUCKET_S >= self.measure_from
                and self.start + (index + 1) * _SAMPLE_BUCKET_S <= self.last_byte_at
            ] if self.last_byte_at is not None else []
        if len(complete) < _MIN_BUCKETS_FOR_PERCENTILE:
            return None
        rates = sorted(count * 8 / 1_000_000 / _SAMPLE_BUCKET_S for count in complete)
        low = _percentile(rates, 0.10)
        if low <= 0:
            return None
        return _percentile(rates, 0.90) / low


def _download_from_url(session: requests.Session, url: str, on_tick: TickCallback = None) -> float:
    """Single-stream, bounded-duration download, used for "single" mode. _measure_download_multi runs the same idea on
    several threads instead of calling this, so on_tick fires only from the aggregator loop (see its docstring)."""
    sampler = _ThroughputSampler(_DOWNLOAD_WARMUP_S)
    stop_time = sampler.start + _DOWNLOAD_MAX_DURATION_S
    last_tick = sampler.start
    rate_limited = False
    # 续请求：一份读完而时间窗没到就再要一份。见 _DOWNLOAD_REQUEST_SIZE_BYTES
    # 的注释——这是"服务端单次请求有上限"和"时间窗要跑满"之间唯一不打架的解法。
    while _clock() < stop_time:
        try:
            with session.get(url, timeout=_DOWNLOAD_REQUEST_TIMEOUT_S, stream=True) as resp:
                if resp.status_code == _RATE_LIMIT_STATUS and not sampler.total_bytes:
                    # 限流是暂时的：退避后接着试，时间窗到了自然退出循环。
                    rate_limited = True
                    time.sleep(_RATE_LIMIT_BACKOFF_S)
                    continue
                if resp.status_code >= 400:
                    # 服务器**回话了**，只是拒绝了这次请求。绝不能报成"网络不可达"。
                    raise SpeedTestServerError("download", resp.status_code)
                for chunk in resp.iter_content(chunk_size=_DOWNLOAD_CHUNK_SIZE):
                    now = _clock()
                    sampler.add(len(chunk), now)
                    if on_tick and now - last_tick >= _TICK_INTERVAL_S:
                        live = sampler.live_mbps(now)
                        if live is not None:
                            on_tick(round(live, 2))
                            last_tick = now
                    if now >= stop_time:
                        break
        except requests.RequestException as exc:
            # 已经收到过字节 → 这条链路是通的，只是中途断了；用手上的数据算完就好，
            # 别把一次半途而废的重连说成"没有网络"。
            if sampler.total_bytes:
                break
            raise NetworkUnreachableError("download") from exc
    # 整个时间窗都被限流、一个字节没拿到必须报错，不能返回 0.0：显示「下载 0 Mbps」会让用户去查网线和路由器，
    # 而实情是测速服务器暂时不接客。
    if rate_limited and sampler.total_bytes == 0:
        raise SpeedTestServerError("download", _RATE_LIMIT_STATUS)
    return sampler


def _measure_download(session: requests.Session, on_tick: TickCallback = None) -> "_ThroughputSampler":
    url = _DOWNLOAD_URL.format(size=_DOWNLOAD_REQUEST_SIZE_BYTES)
    return _download_from_url(session, url, on_tick)


def _measure_download_multi(session: requests.Session, on_tick: TickCallback = None) -> "_ThroughputSampler":
    """多流并发版本：_MULTI_CONNECTION_COUNT 个线程各跑一条流式下载，加总到加锁的共享计数器；
    socket IO 释放 GIL，是真并发。on_tick 只在本函数的轮询循环里调用（worker 只加字节），避免多线程回调使 stdout 进度消息交错。"""
    url = _DOWNLOAD_URL.format(size=_DOWNLOAD_REQUEST_SIZE_BYTES)
    sampler = _ThroughputSampler(_DOWNLOAD_WARMUP_S)
    stop_time = sampler.start + _DOWNLOAD_MAX_DURATION_S
    lock = threading.Lock()

    # 各线程看到的 HTTP 拒绝码。全体都拿不到字节时用它区分"服务器拒绝"和
    # "网络不通"——12 条流整整齐齐地收到 403，说明网络好得很，是测速源不干。
    rejected: List[int] = []

    def worker(index: int) -> None:
        # 错峰启动，见 _STREAM_STAGGER_S。
        time.sleep(index * _STREAM_STAGGER_S)
        try:
            # 跟单流版一样续请求，理由见 _DOWNLOAD_REQUEST_SIZE_BYTES。
            while _clock() < stop_time:
                with session.get(url, timeout=_DOWNLOAD_REQUEST_TIMEOUT_S, stream=True) as resp:
                    if resp.status_code >= 400:
                        with lock:
                            rejected.append(resp.status_code)
                        if resp.status_code == _RATE_LIMIT_STATUS:
                            # 限流是**暂时**的，退避后接着试，别让这条流就此退出——
                            # 12 条流一起退出就是一个字节都收不到，整个测速失败。
                            time.sleep(_RATE_LIMIT_BACKOFF_S)
                            continue
                        return
                    for chunk in resp.iter_content(chunk_size=_DOWNLOAD_CHUNK_SIZE):
                        now = _clock()
                        sampler.add(len(chunk), now)
                        if now >= stop_time:
                            return
        except requests.RequestException:
            pass  # 单条流失败不代表整体失败——聚合结果里看总字节数是否为0来判定

    threads = [
        threading.Thread(target=worker, args=(index,), daemon=True)
        for index in range(_MULTI_CONNECTION_COUNT)
    ]
    for t in threads:
        t.start()

    last_tick = sampler.start
    while any(t.is_alive() for t in threads):
        now = _clock()
        if on_tick and now - last_tick >= _TICK_INTERVAL_S:
            live = sampler.live_mbps(now)
            if live is not None:
                on_tick(round(live, 2))
                last_tick = now
        time.sleep(0.02)
    for t in threads:
        t.join()

    with lock:
        first_rejection = rejected[0] if rejected else None
    if sampler.total_bytes == 0:
        if first_rejection is not None:
            raise SpeedTestServerError("download", first_rejection)
        raise NetworkUnreachableError("download")
    return sampler


def _upload_body(sampler: "_ThroughputSampler", sent_holder: dict, on_tick: TickCallback = None):
    """生成上传内容，同时把发出的字节喂给采样器。上传同样要丢掉爬坡段（见 _DOWNLOAD_WARMUP_S），家用宽带上行窄，慢启动更明显。

    计的是 yield 出去的字节而非确认送达的（HTTP 层拿不到）：最初几百 KB 偏乐观（socket 发送缓冲未满），
    之后 requests 写 socket 会阻塞，速度被真实上行钉住；预热窗口正是丢掉这段缓冲填充期。
    """
    tick_state = {"last": sampler.start}
    chunk = b"0" * _UPLOAD_CHUNK_SIZE
    while sent_holder["n"] < _UPLOAD_SIZE_BYTES and _clock() - sampler.start < _UPLOAD_MAX_DURATION_S:
        sent_holder["n"] += len(chunk)
        now = _clock()
        sampler.add(len(chunk), now)
        if on_tick and now - tick_state["last"] >= _TICK_INTERVAL_S:
            live = sampler.live_mbps(now)
            if live is not None:
                on_tick(round(live, 2))
                tick_state["last"] = now
        yield chunk


def _new_upload_holder() -> dict:
    return {"n": 0, "measured": 0, "measured_start": None}


def _measure_upload(session: requests.Session, on_tick: TickCallback = None) -> "_ThroughputSampler":
    sent_holder = _new_upload_holder()
    sampler = _ThroughputSampler(_UPLOAD_WARMUP_S)
    try:
        resp = session.post(
            _UPLOAD_URL, data=_upload_body(sampler, sent_holder, on_tick), timeout=_UPLOAD_REQUEST_TIMEOUT_S
        )
        if resp.status_code >= 400:
            raise SpeedTestServerError("upload", resp.status_code)
    except requests.RequestException as exc:
        raise NetworkUnreachableError("upload") from exc
    return sampler


def _measure_upload_multi(session: requests.Session, on_tick: TickCallback = None) -> "_ThroughputSampler":
    """同 _measure_download_multi，方向相反：_MULTI_CONNECTION_COUNT 个线程各 POST 一份字节流，共享计数器加总；on_tick 只在本函数轮询循环里调用。"""
    sampler = _ThroughputSampler(_UPLOAD_WARMUP_S)
    stop_time = sampler.start + _UPLOAD_MAX_DURATION_S
    lock = threading.Lock()

    def per_thread_body():
        chunk = b"0" * _UPLOAD_CHUNK_SIZE
        sent = 0
        while sent < _UPLOAD_SIZE_BYTES and _clock() < stop_time:
            sent += len(chunk)
            sampler.add(len(chunk), _clock())
            yield chunk

    # 跟下载多流版同一个理由：全体都发不出去时，要能区分"服务器拒收"和"网络不通"。
    rejected_up: List[int] = []

    def worker(index: int) -> None:
        time.sleep(index * _STREAM_STAGGER_S)  # 错峰启动，见 _STREAM_STAGGER_S
        try:
            resp = session.post(_UPLOAD_URL, data=per_thread_body(), timeout=_UPLOAD_REQUEST_TIMEOUT_S)
            if resp.status_code >= 400:
                with lock:
                    rejected_up.append(resp.status_code)
        except requests.RequestException:
            pass  # 单条流失败不代表整体失败——聚合结果里看总字节数是否为0来判定

    threads = [
        threading.Thread(target=worker, args=(index,), daemon=True)
        for index in range(_MULTI_CONNECTION_COUNT)
    ]
    for t in threads:
        t.start()

    last_tick = sampler.start
    while any(t.is_alive() for t in threads):
        now = _clock()
        if on_tick and now - last_tick >= _TICK_INTERVAL_S:
            live = sampler.live_mbps(now)
            if live is not None:
                on_tick(round(live, 2))
                last_tick = now
        time.sleep(0.02)
    for t in threads:
        t.join()

    with lock:
        first_rejection = rejected_up[0] if rejected_up else None
    if sampler.total_bytes == 0:
        if first_rejection is not None:
            raise SpeedTestServerError("upload", first_rejection)
        raise NetworkUnreachableError("upload")
    return sampler


def run_speed_test(
    connection_mode: ConnectionMode = "single",
    on_phase: PhaseCallback = None,
) -> SpeedTestResult:
    """Measures the direct path. connection_mode: single-stream (comparable to older results) or multi-stream
    (_MULTI_CONNECTION_COUNT streams summed, closer to professional tools on fast/high-latency lines).
    `on_phase(phase, data)` fires once for "ip" (IPv4/IPv6, either may be None), once for "ping" (with ping_min_ms/ping_max_ms, median, jitter),
    then roughly every _TICK_INTERVAL_S during download/upload with the speed so far, plus a final per-phase value
    (carrying that phase's loaded-latency reading, see _measure_loaded_ping), so the UI shows the number climbing."""
    dns_ms = _measure_dns(_SPEEDTEST_HOSTNAME)
    if on_phase:
        on_phase("dns", {"dns_ms": round(dns_ms, 1) if dns_ms is not None else None})

    session = _build_session()
    try:
        ipv4, ipv6 = _measure_ip_addresses(session)
        edge_node = _detect_edge_node(session)
        if on_phase:
            on_phase("ip", {"ipv4": ipv4, "ipv6": ipv6, "edge_node": edge_node})

        ping_ms, jitter_ms, loss_ratio, ping_min_ms, ping_max_ms = _measure_ping(session)
        if on_phase:
            on_phase("ping", {
                "ping_ms": round(ping_ms, 1),
                "jitter_ms": round(jitter_ms, 1),
                "loss_ratio": round(loss_ratio, 3),
                "ping_min_ms": round(ping_min_ms, 1),
                "ping_max_ms": round(ping_max_ms, 1),
            })

        download_fn = _measure_download_multi if connection_mode == "multi" else _measure_download
        download_sampler, download_ping_samples = _run_with_loaded_ping(
            session,
            lambda: download_fn(session, on_tick=(lambda mbps: on_phase("download", {"download_mbps": mbps})) if on_phase else None),
        )
        # 终值走 p90 稳态口径，不是"总字节 ÷ 总时间"——理由见 _ThroughputSampler
        # 上面那段实测记录。实时读数仍是累计口径，两者不一样是**有意的**。
        download_mbps = download_sampler.final_mbps()
        download_stability = download_sampler.stability_ratio()
        download_loaded_ping_ms = statistics.median(download_ping_samples) if download_ping_samples else None
        if on_phase:
            on_phase("download", {
                "download_mbps": round(download_mbps, 2),
                "download_loaded_ping_ms": round(download_loaded_ping_ms, 1) if download_loaded_ping_ms is not None else None,
                "download_stability": round(download_stability, 2) if download_stability is not None else None,
            })

        upload_fn = _measure_upload_multi if connection_mode == "multi" else _measure_upload
        upload_sampler, upload_ping_samples = _run_with_loaded_ping(
            session,
            lambda: upload_fn(session, on_tick=(lambda mbps: on_phase("upload", {"upload_mbps": mbps})) if on_phase else None),
        )
        upload_mbps = upload_sampler.final_mbps()
        upload_stability = upload_sampler.stability_ratio()
        upload_loaded_ping_ms = statistics.median(upload_ping_samples) if upload_ping_samples else None
        if on_phase:
            on_phase("upload", {
                "upload_mbps": round(upload_mbps, 2),
                "upload_loaded_ping_ms": round(upload_loaded_ping_ms, 1) if upload_loaded_ping_ms is not None else None,
                "upload_stability": round(upload_stability, 2) if upload_stability is not None else None,
            })
    finally:
        session.close()

    return SpeedTestResult(
        ping_ms=round(ping_ms, 1),
        jitter_ms=round(jitter_ms, 1),
        loss_ratio=round(loss_ratio, 3),
        dns_ms=round(dns_ms, 1) if dns_ms is not None else None,
        download_mbps=round(download_mbps, 2),
        upload_mbps=round(upload_mbps, 2),
        node_label=NODE_LABEL,
        ipv4=ipv4,
        ipv6=ipv6,
        connection_mode=connection_mode,
        edge_node=edge_node,
        stream_count=_MULTI_CONNECTION_COUNT if connection_mode == "multi" else 1,
        measured_seconds=round(_DOWNLOAD_MAX_DURATION_S - _DOWNLOAD_WARMUP_S, 1),
        ping_min_ms=round(ping_min_ms, 1),
        ping_max_ms=round(ping_max_ms, 1),
        download_loaded_ping_ms=round(download_loaded_ping_ms, 1) if download_loaded_ping_ms is not None else None,
        upload_loaded_ping_ms=round(upload_loaded_ping_ms, 1) if upload_loaded_ping_ms is not None else None,
        download_stability=round(download_stability, 2) if download_stability is not None else None,
        upload_stability=round(upload_stability, 2) if upload_stability is not None else None,
    )
