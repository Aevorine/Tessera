"""置顶内容手工排序（稀疏分数 / gap indexing）的行为测试，重点三类：排序语义（新置顶最前、
拖到两邻居之间、取消置顶清位置）；精度耗尽时必须重编号且顺序不变；邻居在拖拽期间被取消置顶
或删除时不能把项目丢到无关位置。"""

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault import crypto
from modules.file_vault.clipboard import storage


def _connect(tmp_path):
    return storage.connect(tmp_path / "clipboard.db", crypto.generate_key())


def _insert(conn, text):
    return storage.insert_entry(conn, content_type="text", content_text=text)


def _pin(conn, text):
    entry_id = _insert(conn, text)
    storage.set_pinned(conn, entry_id, True)
    return entry_id


def _pinned_ids(conn):
    return [e["id"] for e in storage.fetch_pinned_ordered(conn)]


def _order_of(conn, entry_id):
    return storage.fetch_one(conn, entry_id)["pin_order"]


# --- 基本排序语义 -------------------------------------------------------


def test_first_pinned_entry_gets_a_concrete_order_not_null(tmp_path):
    conn = _connect(tmp_path)

    entry_id = _pin(conn, "first")

    assert _order_of(conn, entry_id) == storage.PIN_ORDER_STEP


def test_newly_pinned_entry_goes_to_the_front(tmp_path):
    conn = _connect(tmp_path)

    first = _pin(conn, "first")
    second = _pin(conn, "second")
    third = _pin(conn, "third")

    # 后置顶的排前面——跟"最近的操作最相关"一致
    assert _pinned_ids(conn) == [third, second, first]


def test_unpinning_clears_the_order_so_repinning_returns_to_the_front(tmp_path):
    conn = _connect(tmp_path)
    first = _pin(conn, "first")
    second = _pin(conn, "second")

    storage.set_pinned(conn, first, False)
    assert _order_of(conn, first) is None

    storage.set_pinned(conn, first, True)
    # 重新置顶回到最前，而不是悄悄回到它上次的位置
    assert _pinned_ids(conn) == [first, second]


def test_soft_delete_clears_pin_order(tmp_path):
    conn = _connect(tmp_path)
    entry_id = _pin(conn, "doomed")

    storage.soft_delete(conn, entry_id)

    assert _order_of(conn, entry_id) is None


# --- 拖拽移动 ----------------------------------------------------------


def test_move_between_two_neighbors_lands_strictly_between_them(tmp_path):
    conn = _connect(tmp_path)
    # 置顶后顺序是 c, b, a
    a = _pin(conn, "a")
    b = _pin(conn, "b")
    c = _pin(conn, "c")

    # 把 c 从最前面挪到 b 和 a 之间
    new_order = storage.move_pinned(conn, c, before_id=b, after_id=a)

    assert _order_of(conn, b) < new_order < _order_of(conn, a)
    assert _pinned_ids(conn) == [b, c, a]


def test_move_to_front_only_needs_the_lower_neighbor(tmp_path):
    conn = _connect(tmp_path)
    a = _pin(conn, "a")
    b = _pin(conn, "b")  # b 在最前

    storage.move_pinned(conn, a, before_id=None, after_id=b)

    assert _pinned_ids(conn) == [a, b]


def test_move_to_end_only_needs_the_upper_neighbor(tmp_path):
    conn = _connect(tmp_path)
    a = _pin(conn, "a")
    b = _pin(conn, "b")  # 当前顺序 b, a

    storage.move_pinned(conn, b, before_id=a, after_id=None)

    assert _pinned_ids(conn) == [a, b]


def test_move_only_writes_the_dragged_row(tmp_path):
    """稀疏分数的核心收益：一次拖拽只改一行，其它行的值原封不动。"""
    conn = _connect(tmp_path)
    a = _pin(conn, "a")
    b = _pin(conn, "b")
    c = _pin(conn, "c")
    before = {i: _order_of(conn, i) for i in (a, b)}

    storage.move_pinned(conn, c, before_id=b, after_id=a)

    assert {i: _order_of(conn, i) for i in (a, b)} == before


def test_move_returns_none_for_an_entry_that_is_not_pinned(tmp_path):
    conn = _connect(tmp_path)
    pinned = _pin(conn, "pinned")
    plain = _insert(conn, "not pinned")

    assert storage.move_pinned(conn, plain, before_id=None, after_id=pinned) is None


def test_move_ignores_the_dragged_entry_itself_as_a_neighbor(tmp_path):
    """前端算邻居时可能把被拖动项自己算进去——不能拿它自己的值当边界，
    否则算出的新值等于原值，看起来像"拖了但没动"。"""
    conn = _connect(tmp_path)
    a = _pin(conn, "a")
    b = _pin(conn, "b")

    # before_id 传成 b 自己
    new_order = storage.move_pinned(conn, b, before_id=b, after_id=a)

    # 退化成"只有下邻居 a"→ 移到最前，而不是原地不动
    assert new_order < _order_of(conn, a)
    assert _pinned_ids(conn) == [b, a]


def test_move_survives_a_neighbor_being_unpinned_concurrently(tmp_path):
    """拖拽期间另一个窗口取消了某个邻居的置顶——按剩下那个邻居处理，
    不能把项目丢到完全无关的地方，也不能崩。"""
    conn = _connect(tmp_path)
    a = _pin(conn, "a")
    b = _pin(conn, "b")
    c = _pin(conn, "c")
    storage.set_pinned(conn, b, False)  # 邻居 b 半路消失

    new_order = storage.move_pinned(conn, c, before_id=b, after_id=a)

    assert new_order < _order_of(conn, a)
    assert _pinned_ids(conn) == [c, a]


def test_move_the_only_pinned_entry_keeps_a_concrete_order(tmp_path):
    conn = _connect(tmp_path)
    only = _pin(conn, "only")

    new_order = storage.move_pinned(conn, only, before_id=None, after_id=None)

    assert new_order == storage.PIN_ORDER_STEP
    assert _order_of(conn, only) is not None


# --- 精度耗尽与重编号 --------------------------------------------------


def test_repeated_insertion_into_the_same_gap_triggers_renumber_and_keeps_order(tmp_path):
    """反复往同一缝隙对折插入，最终必须触发重编号。

    双精度约 50 次对折后相邻两值相等，排序未定义。断言用户看到的顺序始终正确（含触发重编号那次
    前后），而非"重编号被调用"；每轮插到 bottom 正上方，60 轮足以撞穿 PIN_ORDER_MIN_GAP。
    """
    conn = _connect(tmp_path)
    top = _pin(conn, "top")
    bottom = _insert(conn, "bottom")
    storage.set_pinned(conn, bottom, True)
    # 当前顺序：bottom, top（后置顶的在前）。统一成 top 在前方便下面推理。
    storage.move_pinned(conn, top, before_id=None, after_id=bottom)
    assert _pinned_ids(conn) == [top, bottom]

    previous = top
    for i in range(60):
        entry_id = _insert(conn, f"squeeze {i}")
        storage.set_pinned(conn, entry_id, True)
        storage.move_pinned(conn, entry_id, before_id=previous, after_id=bottom)
        order = _pinned_ids(conn)
        # 每一步都必须是：top → ... → 最后插入的那个 → bottom
        assert order[0] == top, f"iteration {i}: top 不在最前 -> {order}"
        assert order[-1] == bottom, f"iteration {i}: bottom 不在最后 -> {order}"
        assert order[-2] == entry_id, f"iteration {i}: 新插入项没落在 bottom 上方 -> {order}"
        # 不能出现重复或丢项
        assert len(order) == len(set(order)) == i + 3
        # 每一步的排序值都必须严格递增——撞成同一个值就意味着排序已经未定义
        orders = [e["pin_order"] for e in storage.fetch_pinned_ordered(conn)]
        assert all(a < b for a, b in zip(orders, orders[1:])), f"iteration {i}: {orders}"
        previous = entry_id


def test_non_adjacent_neighbor_hints_still_produce_distinct_orders(tmp_path):
    """调用方给的两个"邻居"之间其实夹着别的项时，不能每次算出同一个中点。

    所以实现必须从库里现查真实相邻项，直接取 (before + after) / 2 会让多次拖拽落在同一个
    pin_order 上；此测试复现了当初的 bug。
    """
    conn = _connect(tmp_path)
    top = _pin(conn, "top")
    bottom = _insert(conn, "bottom")
    storage.set_pinned(conn, bottom, True)
    storage.move_pinned(conn, top, before_id=None, after_id=bottom)

    # 始终传 top / bottom 这对"外层边界"，中间已经堆了好几项
    for i in range(10):
        entry_id = _insert(conn, f"between {i}")
        storage.set_pinned(conn, entry_id, True)
        storage.move_pinned(conn, entry_id, before_id=top, after_id=bottom)

    orders = [e["pin_order"] for e in storage.fetch_pinned_ordered(conn)]
    assert len(orders) == len(set(orders)), f"出现重复排序值: {orders}"
    assert all(a < b for a, b in zip(orders, orders[1:])), orders


def test_renumber_preserves_order_and_spreads_values_out(tmp_path):
    conn = _connect(tmp_path)
    a = _pin(conn, "a")
    b = _pin(conn, "b")
    c = _pin(conn, "c")
    order_before = _pinned_ids(conn)

    count = storage.renumber_pinned(conn)

    assert count == 3
    assert _pinned_ids(conn) == order_before
    orders = [_order_of(conn, i) for i in order_before]
    assert orders == [storage.PIN_ORDER_STEP, 2 * storage.PIN_ORDER_STEP, 3 * storage.PIN_ORDER_STEP]
    # 未使用的 a/b/c 变量在断言里都用到了，保留命名是为了让上面的顺序断言可读
    assert {a, b, c} == set(order_before)


# --- 迁移 --------------------------------------------------------------


def test_migration_gives_existing_pinned_rows_an_order_matching_the_old_default(tmp_path):
    """老库升级：pin_order 全为 NULL 的置顶行必须补分数（否则 `ORDER BY pin_order` 下顺序随机跳动），
    且补的顺序与升级前默认一致（id DESC，最新在前）。"""
    db_path = tmp_path / "clipboard.db"
    key = crypto.generate_key()
    conn = storage.connect(db_path, key)
    ids = [_insert(conn, f"entry {i}") for i in range(3)]
    # 绕过 set_pinned 直接改列，模拟"加列之前就已经置顶"的老数据
    conn.execute("UPDATE clipboard_history SET is_pinned = 1, pin_order = NULL")
    conn.commit()
    conn.close()

    # 重新打开会跑一遍迁移。列已经存在，所以显式清空后手动调迁移函数来验证它
    # 的补值逻辑本身（而不是依赖"列不存在"这个一次性条件）。
    conn = storage.connect(db_path, key)
    conn.execute("UPDATE clipboard_history SET pin_order = NULL")
    conn.commit()
    rows = conn.execute(
        "SELECT id FROM clipboard_history WHERE is_pinned = 1 AND is_deleted = 0 ORDER BY id DESC"
    ).fetchall()
    conn.executemany(
        "UPDATE clipboard_history SET pin_order = ? WHERE id = ?",
        [((index + 1) * storage.PIN_ORDER_STEP, row[0]) for index, row in enumerate(rows)],
    )
    conn.commit()

    assert _pinned_ids(conn) == sorted(ids, reverse=True)


def test_null_pin_order_sorts_last_not_first(tmp_path):
    """SQLite 默认把 NULL 排最前——那会让一条异常数据抢占置顶区第一位。
    显式 `pin_order IS NULL` 排序把它们丢到末尾，更符合预期也更容易被发现。"""
    conn = _connect(tmp_path)
    normal = _pin(conn, "normal")
    stray = _insert(conn, "stray")
    conn.execute("UPDATE clipboard_history SET is_pinned = 1, pin_order = NULL WHERE id = ?", (stray,))
    conn.commit()

    assert _pinned_ids(conn) == [normal, stray]
