# -*- coding: utf-8 -*-
"""security_health 用例。评分最危险的失效是算出看似合理却无依据的数字，所以守四条不变量：
1. 总分 = 逐项实得之和 / 逐项满分之和（无隐藏加权）
2. 查不到的项不进分母（不会因"没开跨设备"被扣分）
3. 一项都查不到时不假装知道
4. 权重表总和恒为 100（界面上"各项相加 = 总分"才成立）"""

from __future__ import annotations

import pytest

from modules.file_vault import security_health as sh


def _full_facts(**overrides) -> sh.HealthFacts:
    """一份"全部满分"的事实，用来做单变量对照。"""
    base = dict(
        scrypt_n=2 ** 17,
        scrypt_n_recommended=2 ** 17,
        container_has_per_chunk_tags=True,
        pq_keypair_present=True,
        unlock_methods=["password", "totp", "fingerprint"],
        failed_attempts=0,
        locked_out=False,
        vault_recovery_key_set=True,
        recovery_code_groups=2,
        recovery_code_groups_low_stock=0,
        crossdevice_running=True,
        crossdevice_paired_devices=1,
        crossdevice_last_path_direct=True,
        dependency_vulns_high=0,
        dependency_audit_age_days=3.0,
        signature_verified=True,
        update_channel_pinned=True,
        audit_chain_ok=True,
    )
    base.update(overrides)
    return sh.HealthFacts(**base)


def test_weights_sum_to_100():
    """界面上会写"把每一项的分加起来就是总分"。这条用例保证那句话不是空话。"""
    assert sh.TOTAL_WEIGHT == 100


def test_check_ids_are_unique():
    ids = [c.id for c in sh.CHECKS]
    assert len(ids) == len(set(ids))


def test_perfect_facts_score_100():
    report = sh.evaluate(_full_facts())
    assert report.score == 100
    assert report.grade == "excellent"
    assert report.unknown_count == 0
    assert all(c.status == sh.STATUS_GOOD for c in report.checks)


def test_score_is_plain_weighted_average_no_hidden_curve():
    """总分必须能由明细逐项复算；加了"综合调整"或曲线会红，评分就从"可检查"变成"只能信我"。"""
    report = sh.evaluate(_full_facts(vault_recovery_key_set=False, dependency_vulns_high=2))
    scored = [c for c in report.checks if c.status != sh.STATUS_UNKNOWN]
    earned = sum(c.earned for c in scored)
    weight = sum(c.weight for c in scored)
    assert weight == report.scored_weight
    assert abs(report.score - round(earned / weight * 100)) <= 1


def test_unknown_checks_leave_the_denominator():
    """没开跨设备的机器不该因为"查不到走的哪条路"被扣分。"""
    with_cd = sh.evaluate(_full_facts())
    without_cd = sh.evaluate(_full_facts(crossdevice_running=False))
    assert without_cd.score == with_cd.score == 100
    assert without_cd.scored_weight < with_cd.scored_weight
    assert without_cd.unknown_count == 1


def test_all_unknown_returns_minus_one_not_a_guess():
    """一项都查不到时给 0 分等于说"你很不安全"，给 100 分是撒谎。"""
    report = sh.evaluate(sh.HealthFacts())
    assert report.score == -1
    assert report.grade == "unknown"
    assert report.scored_weight == 0


def test_missing_recovery_key_is_the_heaviest_single_loss():
    """忘了口令 + 没有恢复密钥 = 数据永久消失，没有任何人能帮忙。
    它必须是单项扣分最多的那一条，否则这个评分就没有传达真实的风险次序。"""
    losses = {}
    for check in sh.CHECKS:
        if check.id == "recoveryKey":
            continue
        # 逐项打成最差，看总分掉多少
        worst = {
            "kdf": dict(scrypt_n=2 ** 14),
            "chunkTags": dict(container_has_per_chunk_tags=False),
            "pqKeypair": dict(pq_keypair_present=False),
            "unlockMethods": dict(unlock_methods=[]),
            "failedAttempts": dict(failed_attempts=9, locked_out=True),
            "recoveryCodes": dict(recovery_code_groups=3, recovery_code_groups_low_stock=2),
            "crossdevicePath": dict(crossdevice_last_path_direct=False),
            "dependencies": dict(dependency_vulns_high=5),
            "dependencyFreshness": dict(dependency_audit_age_days=400.0),
            "signature": dict(signature_verified=False),
            "updatePinning": dict(update_channel_pinned=False),
            "auditChain": dict(audit_chain_ok=False),
        }[check.id]
        losses[check.id] = 100 - sh.evaluate(_full_facts(**worst)).score
    recovery_loss = 100 - sh.evaluate(_full_facts(vault_recovery_key_set=False)).score
    assert recovery_loss > max(losses.values()), f"恢复密钥扣 {recovery_loss}，其他最高 {max(losses.values())}"


def test_relay_is_a_warning_not_a_failure():
    """走中继不是漏洞：内容在进中继之前就已经端到端加密。判成红色会训练用户
    忽略红色，那才是真正的安全损失。"""
    report = sh.evaluate(_full_facts(crossdevice_last_path_direct=False))
    check = next(c for c in report.checks if c.id == "crossdevicePath")
    assert check.status == sh.STATUS_WARN
    assert check.earned > 0


def test_unused_recovery_codes_are_not_penalised():
    """没用过恢复码功能的人不该被扣分——那是"你没开这个功能"，不是"你不安全"。"""
    report = sh.evaluate(_full_facts(recovery_code_groups=0, recovery_code_groups_low_stock=0))
    assert report.score == 100


def test_stale_audit_is_itself_a_finding():
    """半年前扫描是干净的，说明不了今天是干净的。"""
    fresh = sh.evaluate(_full_facts(dependency_audit_age_days=5.0))
    stale = sh.evaluate(_full_facts(dependency_audit_age_days=400.0))
    assert stale.score < fresh.score


def test_findings_are_sorted_worst_first():
    """用户打开这一屏是来找"我该做什么"的。"""
    report = sh.evaluate(
        _full_facts(vault_recovery_key_set=False, crossdevice_last_path_direct=False)
    )
    order = [c.status for c in report.checks]
    rank = {sh.STATUS_BAD: 0, sh.STATUS_WARN: 1, sh.STATUS_UNKNOWN: 2, sh.STATUS_GOOD: 3}
    assert order == sorted(order, key=lambda s: rank[s])


@pytest.mark.parametrize("score,grade", [(100, "excellent"), (90, "excellent"), (89, "good"),
                                         (75, "good"), (74, "fair"), (55, "fair"), (54, "attention"),
                                         (0, "attention")])
def test_grade_bands_have_no_gaps(score, grade):
    assert next(name for threshold, name in sh.GRADE_BANDS if score >= threshold) == grade


def test_every_check_emits_a_translatable_key_not_prose():
    """后端返回中文串会让英文界面中英混排；保证 detail_key 永远是点分小写标识符的键。"""
    import re

    report = sh.evaluate(_full_facts(vault_recovery_key_set=False, unlock_methods=["password"]))
    for check in report.checks:
        assert re.fullmatch(r"[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*", check.detail_key), check.detail_key
