from __future__ import annotations

import csv
import io
import os
import webbrowser
from datetime import date

from psb_download_watcher import start_psb_download_watcher
from flask import Flask, jsonify, render_template, request, send_file

from ozon_client import OzonClient, OzonApiError, CONFIRMED_STATUS
from ozon_storage import get_all_operations, get_stats, sync_operations
from psb_importer import PsbStatementError, convert_psb_operations, parse_psb_csv
from psb_storage import get_all_psb_operations, get_psb_stats, sync_psb_operations
from sber_importer import SberStatementError, convert_sber_operations, parse_sber_pdf
from sber_storage import get_all_sber_operations, get_sber_stats, sync_sber_operations
from receipts_routes import receipts_bp

app = Flask(__name__)
app.register_blueprint(receipts_bp)

@app.after_request
def add_extension_cors_headers(response):
    """Allow the local Firefox extension to call this loopback-only app."""
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    response.headers["Access-Control-Max-Age"] = "600"
    return response

OZON_URL = "https://finance.ozon.ru/lk"
PSB_URL = "https://ib.psbank.ru/login"


@app.get("/")
def index():
    return render_template("index.html", page="operations")


@app.get("/settings")
def settings():
    return render_template("index.html", page="settings")


@app.post("/api/connect")
def connect():
    # Open the user's regular browser. No Selenium/GeckoDriver is involved.
    opened = webbrowser.open(OZON_URL)
    return jsonify(
        ok=True,
        opened=bool(opened),
        message="Откройте Ozon Банк в обычном Firefox. После входа запустите закладку-экспорт из инструкции ниже.",
    )


@app.post("/api/connect/psb")
def connect_psb():
    # Open the PSB retail internet-bank login in the user's regular browser.
    opened = webbrowser.open(PSB_URL)
    return jsonify(
        ok=True,
        opened=bool(opened),
        message="Откройте ПСБ в обычном Firefox и войдите в личный кабинет. Затем нажмите значок расширения ПСБ — оно откроет выписку в той же вкладке.",
    )


def _requested_period():
    try:
        start = date.fromisoformat(request.args.get("start", ""))
        end = date.fromisoformat(request.args.get("end", ""))
    except ValueError:
        raise ValueError("Укажите корректный период.")
    if start > end:
        raise ValueError("Дата начала позже даты окончания.")
    return start, end


def _combined_transactions(start: date, end: date):
    ozon_rows, ozon_summary = OzonClient.convert_export_with_summary(
        get_all_operations(), start, end
    )
    psb_rows = convert_psb_operations(get_all_psb_operations(), start, end)
    sber_rows = convert_sber_operations(get_all_sber_operations(), start, end)
    items = ozon_rows + psb_rows + sber_rows
    items.sort(key=lambda row: row.get("time", ""), reverse=True)
    return items, {
        "confirmed": ozon_summary["confirmed"],
        "hold": ozon_summary["hold"],
        "excluded_other": ozon_summary["excluded_other"],
        "psb": len(psb_rows),
        "sber": len(sber_rows),
    }


@app.get("/api/operations")
def list_operations():
    try:
        start, end = _requested_period()
        items, summary = _combined_transactions(start, end)
        return jsonify(
            items=items,
            count=len(items),
            summary=summary,
            database={**get_stats(), "psb_total": get_psb_stats()["total"], "sber_total": get_sber_stats()["total"]},
        )
    except (ValueError, OzonApiError) as exc:
        return jsonify(error=str(exc)), 400


@app.get("/api/stats")
def database_stats():
    stats = get_stats()
    psb_stats = get_psb_stats()
    stats["psb_total"] = psb_stats["total"]
    stats["psb_last_sync_at"] = psb_stats["last_sync_at"]
    sber_stats = get_sber_stats()
    stats["sber_total"] = sber_stats["total"]
    stats["sber_last_sync_at"] = sber_stats["last_sync_at"]
    return jsonify(stats)


@app.get("/api/health")
def health_check():
    """Lightweight connectivity check for the Firefox extension."""
    return jsonify(ok=True, service="ozon-bill")


@app.post("/api/ozon/auto-sync")
def auto_sync_ozon():
    """Receive operation JSON from the Firefox extension running locally."""
    payload = request.get_json(force=True, silent=True)
    if payload is None:
        return jsonify(error="Firefox не передал корректный JSON."), 400
    try:
        sync_summary = sync_operations(payload)
        return jsonify(
            ok=True,
            sync=sync_summary,
            database_total=get_stats()["total"],
            message=f"Ozon обновлён: новых {sync_summary.get('new', 0)}, изменённых {sync_summary.get('updated', 0)}, без изменений {sync_summary.get('unchanged', 0)}.",
        )
    except (OzonApiError, ValueError) as exc:
        return jsonify(error=str(exc)), 400


@app.post("/api/sync")
@app.post("/api/import")
def import_operations():
    payload = request.get_json(silent=True)
    if payload is None:
        return jsonify(error="Не удалось прочитать JSON-файл."), 400
    try:
        start, end = _requested_period()
        sync_summary = sync_operations(payload)
        # Keep the existing Ozon import path intact, then show the combined
        # history from both banks. PSB records live in their own SQLite table.
        items, summary = _combined_transactions(start, end)
        return jsonify(
            items=items,
            count=len(items),
            summary=summary,
            sync=sync_summary,
            database={**get_stats(), "psb_total": get_psb_stats()["total"]},
        )
    except (ValueError, OzonApiError) as exc:
        return jsonify(error=str(exc)), 400


@app.post("/api/psb/auto-sync")
def auto_sync_psb():
    """Receive the CSV text captured from the authenticated PSB page."""
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict) or not isinstance(payload.get("csv"), str):
        return jsonify(error="Расширение не передало содержимое CSV-выписки ПСБ."), 400
    try:
        parsed = parse_psb_csv(payload["csv"])
        sync_summary = sync_psb_operations(parsed)
        return jsonify(
            ok=True,
            sync=sync_summary,
            imported=len(parsed),
            database_total=get_psb_stats()["total"],
            message=f"ПСБ обновлён: новых {sync_summary.get('new', 0)}, изменённых {sync_summary.get('updated', 0)}, без изменений {sync_summary.get('unchanged', 0)}.",
        )
    except (PsbStatementError, ValueError) as exc:
        return jsonify(error=str(exc)), 400


@app.post("/api/psb/import")
def import_psb_statement():
    try:
        start, end = _requested_period()
    except ValueError as exc:
        return jsonify(error=str(exc)), 400

    uploaded = request.files.get("file")
    if uploaded is None or not uploaded.filename:
        return jsonify(error="Выберите CSV-выписку ПСБ."), 400
    try:
        parsed = parse_psb_csv(uploaded.read())
        sync_summary = sync_psb_operations(parsed)
        items, summary = _combined_transactions(start, end)
        return jsonify(
            items=items,
            count=len(items),
            summary=summary,
            sync=sync_summary,
            psb={"imported_from_file": len(parsed), "database_total": get_psb_stats()["total"]},
            database={**get_stats(), "psb_total": get_psb_stats()["total"]},
        )
    except (PsbStatementError, ValueError, OzonApiError) as exc:
        return jsonify(error=str(exc)), 400


@app.post("/api/sber/import")
def import_sber_statement():
    try:
        start, end = _requested_period()
    except ValueError as exc:
        return jsonify(error=str(exc)), 400

    uploaded = request.files.get("file")
    if uploaded is None or not uploaded.filename:
        return jsonify(error="Выберите PDF-выписку Сбербанка."), 400
    if not uploaded.filename.lower().endswith(".pdf"):
        return jsonify(error="Для импорта Сбербанка выберите файл PDF."), 400
    try:
        parsed = parse_sber_pdf(uploaded.read())
        sync_summary = sync_sber_operations(parsed)
        items, summary = _combined_transactions(start, end)
        return jsonify(
            items=items,
            count=len(items),
            summary=summary,
            sync=sync_summary,
            sber={"imported_from_file": len(parsed), "database_total": get_sber_stats()["total"]},
            database={**get_stats(), "psb_total": get_psb_stats()["total"], "sber_total": get_sber_stats()["total"]},
        )
    except (SberStatementError, ValueError, OzonApiError) as exc:
        return jsonify(error=str(exc)), 400


@app.post("/api/database/export")
def export_encrypted_database():
    """Create a consistent SQLite snapshot and encrypt it with a user-supplied password."""
    payload = request.get_json(silent=True) or {}
    password = payload.get("password") if isinstance(payload, dict) else None
    if not isinstance(password, str) or len(password) < 10:
        return jsonify(error="Пароль должен содержать не менее 10 символов."), 400

    from pathlib import Path
    import secrets
    import sqlite3
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.scrypt import Scrypt
    from ozon_storage import DEFAULT_DB_PATH

    source_path = Path(os.getenv("OZON_DB_PATH") or DEFAULT_DB_PATH).expanduser()
    if not source_path.is_file():
        return jsonify(error="Файл базы данных ещё не создан."), 404

    magic = b"OZONENC1"
    salt = secrets.token_bytes(16)
    nonce = secrets.token_bytes(12)
    key = Scrypt(salt=salt, length=32, n=2**15, r=8, p=1).derive(password.encode("utf-8"))
    import tempfile

    # Back up to a temporary SQLite file instead of Connection.serialize(),
    # which is not available in every Python SQLite build.
    with tempfile.TemporaryDirectory(prefix="ozon-db-export-") as temp_dir:
        snapshot_path = Path(temp_dir) / "snapshot.sqlite3"
        source = sqlite3.connect(f"file:{source_path.resolve()}?mode=ro", uri=True, timeout=30)
        try:
            snapshot = sqlite3.connect(str(snapshot_path))
            try:
                source.backup(snapshot)
            finally:
                snapshot.close()
        finally:
            source.close()
        database_bytes = snapshot_path.read_bytes()

    # Layout: magic + salt + nonce + AES-256-GCM ciphertext and authentication tag.
    encrypted = magic + salt + nonce + AESGCM(key).encrypt(nonce, database_bytes, magic + salt)
    filename = f"ozon_operations_{date.today().isoformat()}.sqlite3.enc"
    return send_file(io.BytesIO(encrypted), mimetype="application/octet-stream",
                     as_attachment=True, download_name=filename)


@app.post("/api/database/import")
def import_encrypted_database():
    """Decrypt and validate a backup before atomically replacing the live SQLite database."""
    from pathlib import Path
    import sqlite3
    import tempfile
    from cryptography.exceptions import InvalidTag
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.scrypt import Scrypt
    from ozon_storage import DEFAULT_DB_PATH

    uploaded = request.files.get("file")
    password = request.form.get("password", "")
    if uploaded is None or not uploaded.filename:
        return jsonify(error="Выберите зашифрованную резервную копию .sqlite3.enc."), 400
    if len(password) < 10:
        return jsonify(error="Введите пароль длиной не менее 10 символов."), 400

    encrypted = uploaded.read()
    magic = b"OZONENC1"
    header_size = len(magic) + 16 + 12
    if len(encrypted) <= header_size + 16 or not encrypted.startswith(magic):
        return jsonify(error="Файл не является корректной резервной копией Ozon Bill."), 400

    salt = encrypted[len(magic):len(magic) + 16]
    nonce_start = len(magic) + 16
    nonce = encrypted[nonce_start:nonce_start + 12]
    ciphertext = encrypted[header_size:]
    try:
        key = Scrypt(salt=salt, length=32, n=2**15, r=8, p=1).derive(password.encode("utf-8"))
        database_bytes = AESGCM(key).decrypt(nonce, ciphertext, magic + salt)
    except (InvalidTag, ValueError):
        return jsonify(error="Не удалось расшифровать файл. Проверьте пароль и целостность резервной копии."), 400

    source_path = Path(os.getenv("OZON_DB_PATH") or DEFAULT_DB_PATH).expanduser()
    source_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = None
    try:
        # Stage the restored database beside the live file so os.replace is atomic.
        with tempfile.NamedTemporaryFile(prefix=".ozon-restore-", suffix=".sqlite3",
                                         dir=str(source_path.parent), delete=False) as staged:
            temporary_path = Path(staged.name)
            staged.write(database_bytes)
            staged.flush()
            os.fsync(staged.fileno())

        check = sqlite3.connect(f"file:{temporary_path.resolve()}?mode=ro", uri=True, timeout=30)
        try:
            integrity = check.execute("PRAGMA quick_check").fetchone()
            tables = {row[0] for row in check.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )}
            if not integrity or integrity[0] != "ok" or "operations" not in tables:
                raise ValueError("В резервной копии нет корректной базы Ozon Bill.")
        finally:
            check.close()

        # Use SQLite's backup API to replace database contents safely, including
        # when the live database uses WAL mode.
        restored = sqlite3.connect(f"file:{temporary_path.resolve()}?mode=ro", uri=True, timeout=30)
        target = sqlite3.connect(str(source_path), timeout=30)
        try:
            restored.backup(target)
        finally:
            target.close()
            restored.close()
        temporary_path.unlink(missing_ok=True)
        temporary_path = None
        return jsonify(ok=True, message="Резервная копия успешно восстановлена. Данные Ozon, ПСБ и Сбербанка заменены содержимым файла.")
    except (OSError, sqlite3.DatabaseError, ValueError) as exc:
        return jsonify(error=f"Не удалось восстановить базу: {exc}"), 400
    finally:
        if temporary_path is not None:
            try:
                temporary_path.unlink(missing_ok=True)
            except OSError:
                pass


@app.post("/api/export")
def export_csv():
    payload = request.get_json(silent=True) or {}
    selected = payload.get("items") if isinstance(payload, dict) else None
    if not isinstance(selected, list) or not selected:
        return jsonify(error="Нет выбранных операций."), 400

    output = io.StringIO(newline="")
    writer = csv.writer(output, delimiter=";", quoting=csv.QUOTE_MINIMAL, lineterminator="\r\n")
    writer.writerow(["Дата", "Банк", "Название", "Цель", "Категория", "Дебет", "Кредит", "Итого"])
    exported = 0
    for row in selected:
        if not isinstance(row, dict) or row.get("status") != CONFIRMED_STATUS:
            continue
        writer.writerow([
            row.get("date_local", row.get("time", "")), row.get("source") or "Ozon", row.get("name", ""),
            row.get("purpose", ""), row.get("category", ""),
            row.get("debit", ""), row.get("credit", ""), row.get("amount", ""),
        ])
        exported += 1

    if exported == 0:
        return jsonify(error="Нет подтверждённых операций для экспорта."), 400

    data = "\ufeff" + output.getvalue()
    return send_file(io.BytesIO(data.encode("utf-8")), mimetype="text/csv; charset=utf-8",
                     as_attachment=True, download_name=f"bank_operations_{date.today().isoformat()}.csv")


if __name__ == "__main__":
    # Watch for newly downloaded PSB CSV statements without affecting Ozon imports.
    start_psb_download_watcher()
    app.run(host=os.getenv("HOST", "127.0.0.1"), port=int(os.getenv("PORT", "8765")), debug=False)
