from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ozon_storage import DEFAULT_DB_PATH


def _path(db_path=None):
    return Path(db_path or os.getenv("OZON_DB_PATH") or DEFAULT_DB_PATH).expanduser()


def _connect(db_path=None):
    path = _path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=30)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA busy_timeout = 30000")
    return db


def _receipt_list(payload: Any) -> list[dict]:
    if isinstance(payload, list):
        rows = payload
    elif isinstance(payload, dict) and isinstance(payload.get("receipts"), list):
        rows = payload["receipts"]
    else:
        raise ValueError("В JSON не найден массив receipts.")
    result = []
    for row in rows:
        if isinstance(row, dict) and isinstance(row.get("receipt"), dict):
            result.append(row)
    return result


def _key(row: dict) -> str:
    receipt = row["receipt"]
    key = str(receipt.get("key") or "").strip()
    if key:
        return key
    fiscal = row.get("fiscalData") or {}
    parts = [
        receipt.get("fiscalDriveNumber") or fiscal.get("fiscalDriveNumber"),
        receipt.get("fiscalDocumentNumber") or fiscal.get("fiscalDocumentNumber"),
        fiscal.get("fiscalSign"),
    ]
    if all(parts):
        return ":".join(str(x) for x in parts)
    raise ValueError("У одного из чеков отсутствует receipt.key и фискальные реквизиты для дедупликации.")


def sync_receipts(payload: Any, db_path=None) -> dict[str, int | str]:
    rows = _receipt_list(payload)
    now = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
    counts = {"new": 0, "updated": 0, "unchanged": 0, "skipped": 0}
    with _connect(db_path) as db:
        db.execute("""
            CREATE TABLE IF NOT EXISTS receipts (
                receipt_key TEXT PRIMARY KEY,
                receipt_time TEXT NOT NULL DEFAULT '',
                total_sum TEXT NOT NULL DEFAULT '',
                seller TEXT NOT NULL DEFAULT '',
                seller_inn TEXT NOT NULL DEFAULT '',
                raw_json TEXT NOT NULL,
                imported_at TEXT NOT NULL
            )
        """)
        db.execute("CREATE INDEX IF NOT EXISTS idx_receipts_time ON receipts(receipt_time)")
        db.execute("""
            CREATE TABLE IF NOT EXISTS receipts_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
        """)
        for row in rows:
            try:
                key = _key(row)
            except ValueError:
                counts["skipped"] += 1
                continue
            fiscal = row.get("fiscalData") or {}
            receipt = row["receipt"]
            raw = json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            when = str(fiscal.get("dateTime") or receipt.get("createdDate") or receipt.get("receiveDate") or "")
            total = str(fiscal.get("totalSum") or receipt.get("totalSum") or "")
            seller = str(fiscal.get("user") or receipt.get("kktOwner") or "")
            inn = str(fiscal.get("userInn") or receipt.get("kktOwnerInn") or "")
            old = db.execute("SELECT raw_json FROM receipts WHERE receipt_key=?", (key,)).fetchone()
            if old is None:
                db.execute("INSERT INTO receipts VALUES (?, ?, ?, ?, ?, ?, ?)",
                           (key, when, total, seller, inn, raw, now))
                counts["new"] += 1
            elif old["raw_json"] != raw:
                db.execute("""UPDATE receipts SET receipt_time=?, total_sum=?, seller=?, seller_inn=?,
                              raw_json=?, imported_at=? WHERE receipt_key=?""",
                           (when, total, seller, inn, raw, now, key))
                counts["updated"] += 1
            else:
                counts["unchanged"] += 1
        for key, value in {
            "exported_at": str(payload.get("exportedAt") or "") if isinstance(payload, dict) else "",
            "list_complete": str(bool(payload.get("listComplete"))) if isinstance(payload, dict) else "False",
            "details_complete": str(bool(payload.get("detailsComplete"))) if isinstance(payload, dict) else "False",
            "last_sync_at": now,
        }.items():
            db.execute("INSERT INTO receipts_meta VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                       (key, value))
    return {**counts, "last_sync_at": now}


def get_receipts(db_path=None) -> list[dict]:
    with _connect(db_path) as db:
        exists = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='receipts'").fetchone()
        if not exists:
            return []
        rows = db.execute("SELECT raw_json FROM receipts ORDER BY receipt_time DESC, imported_at DESC").fetchall()
    return [json.loads(row["raw_json"]) for row in rows]


def get_receipt_stats(db_path=None) -> dict:
    with _connect(db_path) as db:
        exists = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='receipts'").fetchone()
        if not exists:
            return {"total": 0, "last_sync_at": None}
        total = db.execute("SELECT COUNT(*) FROM receipts").fetchone()[0]
        meta = {r["key"]: r["value"] for r in db.execute("SELECT key,value FROM receipts_meta")}
    return {"total": total, "last_sync_at": meta.get("last_sync_at"),
            "list_complete": meta.get("list_complete") == "True",
            "details_complete": meta.get("details_complete") == "True",
            "exported_at": meta.get("exported_at")}
