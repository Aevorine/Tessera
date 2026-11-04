"""跨线程共用的加密 SQLite 连接：每次进 C 层都持同一把可重入锁。

sqlcipher3 的 DB-API threadsafety=1：连接不能跨线程并发用，`check_same_thread=False` 只是关掉检查。
剪贴板监听、维护、批量任务线程与 RPC 主线程共用连接时，C 层在 sqlite3_step 期间放开 GIL，
另一线程的 commit 会重置正在步进的语句 → 状态错乱，最终堆损坏（0xc0000374）让后端崩溃。

两层：`SerializedConnection` 让每次调用串行（内存安全）；`serialize_storage_api` 让 storage 模块的
一次公开函数调用整段持锁（多语句写入原子，别的线程的 rollback 不会撤掉它的半截写入）。
"""

from __future__ import annotations

import functools
import inspect
import threading
from typing import Any, Callable, Dict

from sqlcipher3 import dbapi2 as sqlcipher


class SerializedCursor:
    """游标的每个会进 C 层的操作都持连接锁。"""

    __slots__ = ("_cur", "_lock")

    def __init__(self, cur, lock: threading.RLock):
        self._cur = cur
        self._lock = lock

    def execute(self, *args, **kwargs):
        with self._lock:
            self._cur.execute(*args, **kwargs)
        return self

    def executemany(self, *args, **kwargs):
        with self._lock:
            self._cur.executemany(*args, **kwargs)
        return self

    def executescript(self, *args, **kwargs):
        with self._lock:
            self._cur.executescript(*args, **kwargs)
        return self

    def fetchone(self):
        with self._lock:
            return self._cur.fetchone()

    def fetchmany(self, *args, **kwargs):
        with self._lock:
            return self._cur.fetchmany(*args, **kwargs)

    def fetchall(self):
        with self._lock:
            return self._cur.fetchall()

    def close(self):
        with self._lock:
            self._cur.close()

    def __iter__(self):
        return self

    def __next__(self):
        with self._lock:
            return next(self._cur)

    def __getattr__(self, name: str) -> Any:
        # description / lastrowid / rowcount / arraysize 等只读属性
        return getattr(self._cur, name)

    def __setattr__(self, name: str, value: Any) -> None:
        if name in SerializedCursor.__slots__:
            object.__setattr__(self, name, value)
        else:
            setattr(self._cur, name, value)


class SerializedConnection:
    """连接代理：execute / commit / rollback / close 等全部经 `lock` 串行。`lock` 公开给需要整段原子的调用方。"""

    def __init__(self, conn):
        object.__setattr__(self, "_conn", conn)
        object.__setattr__(self, "lock", threading.RLock())

    def cursor(self, *args, **kwargs) -> SerializedCursor:
        with self.lock:
            return SerializedCursor(self._conn.cursor(*args, **kwargs), self.lock)

    def execute(self, *args, **kwargs) -> SerializedCursor:
        with self.lock:
            return SerializedCursor(self._conn.execute(*args, **kwargs), self.lock)

    def executemany(self, *args, **kwargs) -> SerializedCursor:
        with self.lock:
            return SerializedCursor(self._conn.executemany(*args, **kwargs), self.lock)

    def executescript(self, *args, **kwargs) -> SerializedCursor:
        with self.lock:
            return SerializedCursor(self._conn.executescript(*args, **kwargs), self.lock)

    def commit(self) -> None:
        with self.lock:
            self._conn.commit()

    def rollback(self) -> None:
        with self.lock:
            self._conn.rollback()

    def close(self) -> None:
        with self.lock:
            self._conn.close()

    def create_function(self, *args, **kwargs):
        with self.lock:
            return self._conn.create_function(*args, **kwargs)

    # `with conn:` 整个事务块持锁：块内多条语句对其他线程原子。
    def __enter__(self):
        self.lock.acquire()
        try:
            self._conn.__enter__()
        except BaseException:
            self.lock.release()
            raise
        return self

    def __exit__(self, exc_type, exc, tb):
        try:
            return self._conn.__exit__(exc_type, exc, tb)
        finally:
            self.lock.release()

    def __getattr__(self, name: str) -> Any:
        # in_transaction / total_changes / row_factory 等
        return getattr(self._conn, name)

    def __setattr__(self, name: str, value: Any) -> None:
        setattr(self._conn, name, value)


def connect(database: str, **kwargs) -> SerializedConnection:
    """同 `sqlcipher.connect`，返回可安全跨线程共用的连接。"""
    kwargs["check_same_thread"] = False
    return SerializedConnection(sqlcipher.connect(database, **kwargs))


def _locked(fn: Callable) -> Callable:
    @functools.wraps(fn)
    def wrapper(conn, *args, **kwargs):
        lock = getattr(conn, "lock", None)
        if lock is None:
            return fn(conn, *args, **kwargs)
        with lock:
            return fn(conn, *args, **kwargs)

    return wrapper


def serialize_storage_api(namespace: Dict[str, Any]) -> None:
    """把本模块里第一个参数名为 `conn` 的公开函数换成整段持锁版本；放在 storage 模块末尾调用一次。"""
    module = namespace.get("__name__")
    for name, fn in list(namespace.items()):
        if name.startswith("_") or not inspect.isfunction(fn) or fn.__module__ != module:
            continue
        params = list(inspect.signature(fn).parameters)
        if params and params[0] == "conn":
            namespace[name] = _locked(fn)
