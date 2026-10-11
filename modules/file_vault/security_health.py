# -*- coding: utf-8 -*-
"""安全体检：把分散的安全状态收成一个分数和"下一步做什么"。

评分必须可检查：每项检查带 `weight` 与 `earned`，相加即总分，无隐藏加权或曲线；每项带 `rule`
和 `fix`，界面直接显示。检查项是声明式的 CHECKS 表，加一项只加数据，避免某分支总分不是 100。
分数 0-100 不是百分比或概率，只表示"本应用提供的措施你用了多少"，界面原样显示这一边界。
本模块只收 `HealthFacts`（布尔和数字）、只出分数和文案，不碰 IMK、金库内容，也不做 IO。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional

__all__ = [
    "HealthFacts",
    "CheckResult",
    "HealthReport",
    "evaluate",
    "CHECKS",
    "GRADE_BANDS",
]



@dataclass
class HealthFacts:
    """体检所需的全部事实（收集在 backend_server，判断在这里）。

    字段用 `Optional` 表示"查不到"而不是 False 兜底：查不到的项标 `unknown` 并移出分母
    （见 evaluate()），否则会凭空扣分。
    """

    # -- 金库加密 --
    scrypt_n: Optional[int] = None
    scrypt_n_recommended: Optional[int] = None
    container_has_per_chunk_tags: Optional[bool] = None
    pq_keypair_present: Optional[bool] = None

    # -- 解锁方式 --
    unlock_methods: Optional[List[str]] = None  # password / totp / email / fingerprint / recovery
    failed_attempts: Optional[int] = None
    locked_out: Optional[bool] = None

    # -- 备份 --
    vault_recovery_key_set: Optional[bool] = None
    recovery_code_groups: Optional[int] = None
    recovery_code_groups_low_stock: Optional[int] = None

    # -- 跨设备 --
    crossdevice_running: Optional[bool] = None
    crossdevice_paired_devices: Optional[int] = None
    crossdevice_last_path_direct: Optional[bool] = None

    # -- 供应链 --
    dependency_vulns_high: Optional[int] = None
    dependency_audit_age_days: Optional[float] = None

    # -- 完整性 --
    signature_verified: Optional[bool] = None
    update_channel_pinned: Optional[bool] = None
    # 「最近操作」时间线的哈希链验没验得过。None = 金库没解锁或这张表还没建，
    # 查不到而不是"验不过"——两者必须分开，见 HealthFacts 的类注释。
    audit_chain_ok: Optional[bool] = None


STATUS_GOOD = "good"
STATUS_WARN = "warn"
STATUS_BAD = "bad"
STATUS_UNKNOWN = "unknown"


@dataclass
class CheckResult:
    id: str
    category: str
    status: str
    weight: int
    earned: int
    # 这是界面三段文本的键，不是文本；翻译在前端（六种语言），后端返回中文串会让切语言时中英混排。
    detail_key: str
    detail_args: Dict[str, object] = field(default_factory=dict)

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "category": self.category,
            "status": self.status,
            "weight": self.weight,
            "earned": self.earned,
            "detailKey": self.detail_key,
            "detailArgs": self.detail_args,
        }


@dataclass
class HealthReport:
    score: int
    grade: str
    checks: List[CheckResult]
    # 分母里实际参与评分的权重（unknown 的项不计入）。界面要显示它，
    # 否则"有三项查不到"的用户会看到一个跟别人不可比的分数却不知道为什么。
    scored_weight: int
    total_weight: int
    unknown_count: int

    def to_json(self) -> dict:
        return {
            "score": self.score,
            "grade": self.grade,
            "checks": [c.to_json() for c in self.checks],
            "scoredWeight": self.scored_weight,
            "totalWeight": self.total_weight,
            "unknownCount": self.unknown_count,
        }


# 只有四档，最低档叫"要处理"而不是"危险"：用户需要的是"先做这一件事"，不是焦虑。
GRADE_BANDS = [(90, "excellent"), (75, "good"), (55, "fair"), (0, "attention")]



@dataclass
class Check:
    id: str
    category: str
    weight: int
    evaluate: Callable[[HealthFacts], Optional[tuple]]
    """返回 (status, earned_ratio, detail_key, detail_args)；返回 None = 查不到。

    `earned_ratio` 是 0.0-1.0，乘以 weight 得实得分。允许小数是因为有些项天然
    是连续的（比如"配了几种解锁方式"），硬掰成通过/不通过会让"配了两种"和
    "一种都没配"拿一样的分。
    """


def _c_kdf(f: HealthFacts):
    if f.scrypt_n is None or f.scrypt_n_recommended is None:
        return None
    if f.scrypt_n >= f.scrypt_n_recommended:
        return (STATUS_GOOD, 1.0, "kdf.ok", {"n": f.scrypt_n})
    return (STATUS_BAD, 0.0, "kdf.legacy", {"n": f.scrypt_n, "want": f.scrypt_n_recommended})


def _c_chunk_tags(f: HealthFacts):
    if f.container_has_per_chunk_tags is None:
        return None
    if f.container_has_per_chunk_tags:
        return (STATUS_GOOD, 1.0, "chunks.ok", {})
    return (STATUS_BAD, 0.0, "chunks.missing", {})


def _c_pq(f: HealthFacts):
    if f.pq_keypair_present is None:
        return None
    # 抗量子密钥**不是**必需品，缺了不该扣满分——它防的是"现在录下来、以后解密"
    # 这种针对性很强的攻击。所以判 warn 且给一半分，而不是 bad 判零。
    if f.pq_keypair_present:
        return (STATUS_GOOD, 1.0, "pq.ok", {})
    return (STATUS_WARN, 0.5, "pq.absent", {})


def _c_unlock_methods(f: HealthFacts):
    methods = f.unlock_methods
    if methods is None:
        return None
    count = len([m for m in methods if m != "recovery"])
    if count >= 3:
        return (STATUS_GOOD, 1.0, "unlock.many", {"count": count})
    if count == 2:
        return (STATUS_GOOD, 0.8, "unlock.two", {"count": count})
    if count == 1:
        # 只有一种解锁方式不是"不安全"，是"脆弱"——忘了口令就永远打不开。
        return (STATUS_WARN, 0.4, "unlock.single", {"count": count})
    return (STATUS_BAD, 0.0, "unlock.none", {})


def _c_failed_attempts(f: HealthFacts):
    if f.failed_attempts is None:
        return None
    if f.locked_out:
        return (STATUS_BAD, 0.0, "attempts.lockedOut", {"count": f.failed_attempts})
    if f.failed_attempts == 0:
        return (STATUS_GOOD, 1.0, "attempts.clean", {})
    if f.failed_attempts <= 3:
        return (STATUS_GOOD, 0.9, "attempts.few", {"count": f.failed_attempts})
    return (STATUS_WARN, 0.3, "attempts.many", {"count": f.failed_attempts})


def _c_vault_recovery(f: HealthFacts):
    if f.vault_recovery_key_set is None:
        return None
    if f.vault_recovery_key_set:
        return (STATUS_GOOD, 1.0, "recoveryKey.ok", {})
    # 这是整张表里最重的一项。没有恢复密钥 + 忘了口令 = 数据永久消失，
    # 而且**没有任何人能帮你**，包括作者。
    return (STATUS_BAD, 0.0, "recoveryKey.missing", {})


def _c_recovery_codes(f: HealthFacts):
    groups = f.recovery_code_groups
    if groups is None:
        return None
    if groups == 0:
        # 没存恢复码不算失分（很多人不用两步验证），判 unknown 又会让提示消失，所以给满分加一句"未使用"。
        return (STATUS_GOOD, 1.0, "recoveryCodes.unused", {})
    low = f.recovery_code_groups_low_stock or 0
    if low == 0:
        return (STATUS_GOOD, 1.0, "recoveryCodes.ok", {"groups": groups})
    return (STATUS_WARN, 0.4, "recoveryCodes.low", {"groups": groups, "low": low})


def _c_crossdevice_path(f: HealthFacts):
    if not f.crossdevice_running:
        return None
    if not f.crossdevice_paired_devices:
        return (STATUS_GOOD, 1.0, "crossdevice.noPeers", {})
    if f.crossdevice_last_path_direct is None:
        return None
    if f.crossdevice_last_path_direct:
        return (STATUS_GOOD, 1.0, "crossdevice.direct", {})
    # 走中继不是漏洞（内容在中继前已端到端加密），所以是 warn 给 0.7 而非 bad；
    # 把无真实风险的事实标红会训练用户忽略红色。
    return (STATUS_WARN, 0.7, "crossdevice.relayed", {})


def _c_deps(f: HealthFacts):
    if f.dependency_vulns_high is None:
        return None
    if f.dependency_vulns_high == 0:
        return (STATUS_GOOD, 1.0, "deps.clean", {})
    return (STATUS_BAD, 0.0, "deps.vulnerable", {"count": f.dependency_vulns_high})


def _c_deps_freshness(f: HealthFacts):
    age = f.dependency_audit_age_days
    if age is None:
        return None
    if age <= 30:
        return (STATUS_GOOD, 1.0, "depsAge.fresh", {"days": round(age)})
    if age <= 90:
        return (STATUS_WARN, 0.5, "depsAge.stale", {"days": round(age)})
    # "上次扫描是半年前"和"扫描结果是干净的"经常被混为一谈。半年前干净说明不了
    # 今天干净，所以过期的扫描结果本身就是一个失分项。
    return (STATUS_BAD, 0.0, "depsAge.veryStale", {"days": round(age)})


def _c_signature(f: HealthFacts):
    if f.signature_verified is None:
        return None
    if f.signature_verified:
        return (STATUS_GOOD, 1.0, "signature.ok", {})
    return (STATUS_BAD, 0.0, "signature.unverified", {})


def _c_update_pinning(f: HealthFacts):
    if f.update_channel_pinned is None:
        return None
    if f.update_channel_pinned:
        return (STATUS_GOOD, 1.0, "update.pinned", {})
    return (STATUS_BAD, 0.0, "update.unpinned", {})


def _c_audit_chain(f: HealthFacts):
    """「最近操作」时间线是否被动过。

    验不过判 BAD：该链只在有人绕过应用直接改数据库时才断，正常的新增、裁剪、清空都不会误报。
    """
    if f.audit_chain_ok is None:
        return None
    if f.audit_chain_ok:
        return (STATUS_GOOD, 1.0, "auditChain.intact", {})
    return (STATUS_BAD, 0.0, "auditChain.broken", {})


# 权重表。总和刻意凑成 100，这样"实得 / 满分"和"分数"在全部项都可查时是同一个
# 数字——用户能自己把每一项的分加起来核对总分，这是"评分可被检查"的最后一环。
CHECKS: List[Check] = [
    Check("kdf", "vault", 12, _c_kdf),
    Check("chunkTags", "vault", 8, _c_chunk_tags),
    Check("pqKeypair", "vault", 5, _c_pq),
    Check("unlockMethods", "access", 12, _c_unlock_methods),
    Check("failedAttempts", "access", 8, _c_failed_attempts),
    Check("recoveryKey", "backup", 20, _c_vault_recovery),
    Check("recoveryCodes", "backup", 5, _c_recovery_codes),
    Check("crossdevicePath", "network", 8, _c_crossdevice_path),
    Check("dependencies", "supplychain", 10, _c_deps),
    Check("dependencyFreshness", "supplychain", 3, _c_deps_freshness),
    Check("signature", "integrity", 5, _c_signature),
    Check("updatePinning", "integrity", 2, _c_update_pinning),
    # 新增此项时从 dependencyFreshness（4→3）和 updatePinning（3→2）各挪 1 分，保证权重总和
    # 仍为 100（界面"各项相加等于总分"依赖它）；挑这两项因为它们讲新鲜度/规范性，而本项更接近安全本身。
    Check("auditChain", "integrity", 2, _c_audit_chain),
]

TOTAL_WEIGHT = sum(c.weight for c in CHECKS)


def evaluate(facts: HealthFacts) -> HealthReport:
    """跑完全部检查，返回分数和逐项明细。

    查不到的项（evaluate 返回 None）不进分母：否则没开跨设备的机器会被扣 8 分，分数会从"做得怎么样"
    滑向"开了多少功能"。
    """
    results: List[CheckResult] = []
    scored_weight = 0
    earned_total = 0.0
    unknown = 0

    for check in CHECKS:
        outcome = check.evaluate(facts)
        if outcome is None:
            unknown += 1
            results.append(
                CheckResult(
                    id=check.id,
                    category=check.category,
                    status=STATUS_UNKNOWN,
                    weight=check.weight,
                    earned=0,
                    detail_key=f"{check.id}.unknown",
                )
            )
            continue
        status, ratio, detail_key, detail_args = outcome
        earned = check.weight * ratio
        scored_weight += check.weight
        earned_total += earned
        results.append(
            CheckResult(
                id=check.id,
                category=check.category,
                status=status,
                weight=check.weight,
                earned=int(round(earned)),
                detail_key=detail_key,
                detail_args=detail_args,
            )
        )

    if scored_weight == 0:
        # 一项都查不到。给 0 分是错的（那等于说"你很不安全"），给 100 也是错的。
        # 这里返回 -1 让界面显示"暂时测不出来"，而不是一个假装知道的数字。
        score = -1
        grade = "unknown"
    else:
        score = int(round(earned_total / scored_weight * 100))
        grade = next(name for threshold, name in GRADE_BANDS if score >= threshold)

    # 排序：先按状态严重程度（要处理的排最前），同级按权重降序。
    # 用户打开这一屏是来找"我该做什么"的，不是来读一份按字母排的清单。
    severity = {STATUS_BAD: 0, STATUS_WARN: 1, STATUS_UNKNOWN: 2, STATUS_GOOD: 3}
    results.sort(key=lambda r: (severity[r.status], -r.weight, r.id))

    return HealthReport(
        score=score,
        grade=grade,
        checks=results,
        scored_weight=scored_weight,
        total_weight=TOTAL_WEIGHT,
        unknown_count=unknown,
    )
