"""Thin wrapper over ai_history/storage.py (like notes/service.py):
owns the encrypted connection lifecycle for RPC handlers."""

from pathlib import Path
from typing import List, Optional

from modules.file_vault.ai_history import storage


class AiHistoryService:
    def __init__(self, data_dir: Path, key: bytes):
        self.conn = storage.connect(data_dir / "ai_history.db", key)

    def stop(self) -> None:
        self.conn.close()

    def list_conversations(self) -> list:
        return storage.fetch_list(self.conn)

    def get_conversation(self, conversation_id: int) -> Optional[dict]:
        return storage.fetch_one(self.conn, conversation_id)

    def save_conversation(self, messages: List[dict], conversation_id: Optional[int] = None) -> dict:
        saved_id = storage.save_conversation(self.conn, messages, conversation_id)
        return storage.fetch_one(self.conn, saved_id)

    def delete_conversations(self, conversation_ids: List[int]) -> int:
        return storage.delete_bulk(self.conn, conversation_ids)

    def delete_all(self) -> int:
        return storage.delete_all(self.conn)
