from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from typing import Any

from ozon_storage import DEFAULT_DB_PATH


def _connect(db_path=None):
    path = db_path or DEFAULT_DB_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=30)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA busy_timeout = 30000")
    return connection


def init_sber_db(db_path=None):
    with _connect(db_path) as connection:
        connection.execute("""
            CREATE TABLE IF NOT EXISTS sber_operations (
                operation_id TEXT PRIMARY KEY,
                operation_time TEXT NOT NULL,
                raw_json TEXT NOT NULL,
                imported_at TEXT NOT NULL
            )
        """)
        connection.execute("CREATE INDEX IF NOT EXISTS idx_sber_operations_time ON sber_operations(operation_time)")


def sync_sber_operations(items: list[dict[str, Any]], db_path=None) -> dict[str, int | str]:
    if not items:
        raise ValueError("В PDF нет операций для сохранения.")
    init_sber_db(db_path)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    counts = {"new": 0, "updated": 0, "unchanged": 0, "skipped": 0}
    with _connect(db_path) as connection:
        for item in items:
            if not isinstance(item, dict) or not item.get("operation_id"):
                counts["skipped"] += 1
                continue
            key = str(item["operation_id"])
            raw = json.dumps(item, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            old = connection.execute("SELECT raw_json FROM sber_operations WHERE operation_id=?", (key,)).fetchone()
            if old is None:
                connection.execute("INSERT INTO sber_operations VALUES (?, ?, ?, ?)", (key, str(item.get("time") or ""), raw, now))
                counts["new"] += 1
            elif old["raw_json"] == raw:
                counts["unchanged"] += 1
            else:
                connection.execute("UPDATE sber_operations SET operation_time=?, raw_json=?, imported_at=? WHERE operation_id=?", (str(item.get("time") or ""), raw, now, key))
                counts["updated"] += 1
        if counts["new"] + counts["updated"] + counts["unchanged"] == 0:
            raise ValueError("Не найдено операций Сбербанка с корректным ID.")
    counts["last_sync_at"] = now
    return counts


def get_all_sber_operations(db_path=None) -> list[dict[str, Any]]:
    init_sber_db(db_path)
    with _connect(db_path) as connection:
        rows = connection.execute("SELECT raw_json FROM sber_operations ORDER BY operation_time DESC").fetchall()
    return [json.loads(row["raw_json"]) for row in rows]


def get_sber_stats(db_path=None) -> dict[str, int | str | None]:
    init_sber_db(db_path)
    with _connect(db_path) as connection:
        total = connection.execute("SELECT COUNT(*) FROM sber_operations").fetchone()[0]
        last = connection.execute("SELECT MAX(imported_at) FROM sber_operations").fetchone()[0]
    return {"total": total, "last_sync_at": last}
