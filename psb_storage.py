from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ozon_storage import DEFAULT_DB_PATH


def _path(db_path=None) -> Path:
    return Path(db_path or os.getenv("OZON_DB_PATH") or DEFAULT_DB_PATH).expanduser()


def _connect(db_path=None):
    path = _path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=30)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA busy_timeout = 30000")
    return connection


def init_psb_db(db_path=None) -> None:
    with _connect(db_path) as connection:
        connection.execute("""
            CREATE TABLE IF NOT EXISTS psb_operations (
                operation_id TEXT PRIMARY KEY,
                operation_time TEXT NOT NULL,
                raw_json TEXT NOT NULL,
                imported_at TEXT NOT NULL
            )
        """)
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_psb_operations_time ON psb_operations(operation_time)"
        )


def sync_psb_operations(items: list[dict[str, Any]], db_path=None) -> dict[str, int | str]:
    if not isinstance(items, list) or not items:
        raise ValueError("В выписке ПСБ нет операций для сохранения.")
    init_psb_db(db_path)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    counts = {"new": 0, "unchanged": 0, "skipped": 0}
    with _connect(db_path) as connection:
        for item in items:
            if not isinstance(item, dict) or not item.get("operation_id"):
                counts["skipped"] += 1
                continue
            operation_id = str(item["operation_id"])
            raw_json = json.dumps(item, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            existing = connection.execute(
                "SELECT raw_json FROM psb_operations WHERE operation_id = ?", (operation_id,)
            ).fetchone()
            if existing is None:
                connection.execute(
                    "INSERT INTO psb_operations(operation_id, operation_time, raw_json, imported_at) VALUES (?, ?, ?, ?)",
                    (operation_id, str(item.get("time") or ""), raw_json, now),
                )
                counts["new"] += 1
            elif existing["raw_json"] == raw_json:
                counts["unchanged"] += 1
            else:
                connection.execute(
                    "UPDATE psb_operations SET operation_time = ?, raw_json = ?, imported_at = ? WHERE operation_id = ?",
                    (str(item.get("time") or ""), raw_json, now, operation_id),
                )
                counts["updated"] = counts.get("updated", 0) + 1
        if counts["new"] + counts["unchanged"] + counts.get("updated", 0) == 0:
            raise ValueError("Не найдено операций ПСБ с корректным идентификатором.")
    counts["last_sync_at"] = now
    return counts


def get_all_psb_operations(db_path=None) -> list[dict[str, Any]]:
    init_psb_db(db_path)
    with _connect(db_path) as connection:
        rows = connection.execute(
            "SELECT raw_json FROM psb_operations ORDER BY operation_time DESC"
        ).fetchall()
    return [json.loads(row["raw_json"]) for row in rows]


def get_psb_stats(db_path=None) -> dict[str, int | str | None]:
    init_psb_db(db_path)
    with _connect(db_path) as connection:
        total = connection.execute("SELECT COUNT(*) FROM psb_operations").fetchone()[0]
        last_sync_at = connection.execute(
            "SELECT MAX(imported_at) FROM psb_operations"
        ).fetchone()[0]
    return {"total": total, "last_sync_at": last_sync_at}
