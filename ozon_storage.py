from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_DB_PATH = Path(__file__).resolve().parent / "data" / "ozon_operations.sqlite3"


def _db_path(db_path: str | os.PathLike[str] | None = None) -> Path:
    return Path(db_path or os.getenv("OZON_DB_PATH") or DEFAULT_DB_PATH).expanduser()


def _connect(db_path: str | os.PathLike[str] | None = None) -> sqlite3.Connection:
    path = _db_path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=30)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA busy_timeout = 30000")
    return connection


def init_db(db_path: str | os.PathLike[str] | None = None) -> None:
    with _connect(db_path) as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS operations (
                operation_id TEXT PRIMARY KEY,
                operation_time TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT '',
                raw_json TEXT NOT NULL,
                imported_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_operations_time ON operations(operation_time)"
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS app_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
            """
        )


def _extract_items(payload: Any) -> list[Any]:
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        items = payload.get("items")
        if items is None:
            data = payload.get("data") or {}
            me = data.get("me") or {}
            client = me.get("client") or {}
            group = client.get("groupOperationsV3") or {}
            items = group.get("items")
        if isinstance(items, list):
            return items
    raise ValueError(
        "В JSON-файле не найден список операций. Скачайте файл повторно из личного кабинета."
    )


def sync_operations(
    payload: Any, db_path: str | os.PathLike[str] | None = None
) -> dict[str, int | str]:
    """Insert new operations and update changed records using lastOperationId."""
    items = _extract_items(payload)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    counts = {"new": 0, "updated": 0, "unchanged": 0, "skipped": 0}

    init_db(db_path)
    with _connect(db_path) as connection:
        for item in items:
            if not isinstance(item, dict):
                counts["skipped"] += 1
                continue
            operation_id = str(item.get("lastOperationId") or "").strip()
            if not operation_id:
                counts["skipped"] += 1
                continue

            raw_json = json.dumps(
                item, ensure_ascii=False, sort_keys=True, separators=(",", ":")
            )
            operation_time = str(item.get("time") or "")
            status = str(item.get("status") or "")
            existing = connection.execute(
                "SELECT raw_json FROM operations WHERE operation_id = ?",
                (operation_id,),
            ).fetchone()

            if existing is None:
                connection.execute(
                    """
                    INSERT INTO operations
                        (operation_id, operation_time, status, raw_json, imported_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (operation_id, operation_time, status, raw_json, now),
                )
                counts["new"] += 1
            elif existing["raw_json"] != raw_json:
                connection.execute(
                    """
                    UPDATE operations
                    SET operation_time = ?, status = ?, raw_json = ?, imported_at = ?
                    WHERE operation_id = ?
                    """,
                    (operation_time, status, raw_json, now, operation_id),
                )
                counts["updated"] += 1
            else:
                counts["unchanged"] += 1

        if counts["new"] + counts["updated"] + counts["unchanged"] == 0:
            raise ValueError(
                "В файле нет операций с lastOperationId. База не была изменена."
            )

        for key in ("new", "updated", "unchanged", "skipped"):
            connection.execute(
                """
                INSERT INTO app_meta(key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
                """,
                (f"last_sync_{key}", str(counts[key])),
            )
        connection.execute(
            """
            INSERT INTO app_meta(key, value) VALUES ('last_sync_at', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """,
            (now,),
        )

    counts["last_sync_at"] = now
    return counts


def get_all_operations(db_path: str | os.PathLike[str] | None = None) -> list[dict[str, Any]]:
    init_db(db_path)
    with _connect(db_path) as connection:
        rows = connection.execute(
            "SELECT raw_json FROM operations ORDER BY operation_time DESC"
        ).fetchall()
    return [json.loads(row["raw_json"]) for row in rows]


def get_stats(db_path: str | os.PathLike[str] | None = None) -> dict[str, Any]:
    init_db(db_path)
    with _connect(db_path) as connection:
        total = connection.execute("SELECT COUNT(*) FROM operations").fetchone()[0]
        confirmed = connection.execute(
            "SELECT COUNT(*) FROM operations WHERE status = 'GROUP_OPERATION_CONFIRMED'"
        ).fetchone()[0]
        holds = connection.execute(
            "SELECT COUNT(*) FROM operations WHERE status = 'GROUP_OPERATION_HOLD'"
        ).fetchone()[0]
        meta = {
            row["key"]: row["value"]
            for row in connection.execute("SELECT key, value FROM app_meta")
        }
    return {
        "total": total,
        "confirmed": confirmed,
        "hold": holds,
        "last_sync_at": meta.get("last_sync_at"),
        "last_sync_new": int(meta.get("last_sync_new", 0)),
        "last_sync_updated": int(meta.get("last_sync_updated", 0)),
        "last_sync_unchanged": int(meta.get("last_sync_unchanged", 0)),
        "last_sync_skipped": int(meta.get("last_sync_skipped", 0)),
    }
