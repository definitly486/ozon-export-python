from __future__ import annotations

import csv
import io
import os
import webbrowser
from datetime import date
from flask import Flask, jsonify, render_template, request, send_file

from ozon_client import OzonClient, OzonApiError, CONFIRMED_STATUS
from ozon_storage import get_all_operations, get_stats, sync_operations
from psb_importer import PsbStatementError, convert_psb_operations, parse_psb_csv
from psb_storage import get_all_psb_operations, get_psb_stats, sync_psb_operations

app = Flask(__name__)

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
    return render_template("index.html")


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
        message="Откройте ПСБ в обычном Firefox и войдите в личный кабинет. Затем откройте страницу выписки и выберите период.",
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
    items = ozon_rows + psb_rows
    items.sort(key=lambda row: row.get("time", ""), reverse=True)
    return items, {
        "confirmed": ozon_summary["confirmed"],
        "hold": ozon_summary["hold"],
        "excluded_other": ozon_summary["excluded_other"],
        "psb": len(psb_rows),
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
            database={**get_stats(), "psb_total": get_psb_stats()["total"]},
        )
    except (ValueError, OzonApiError) as exc:
        return jsonify(error=str(exc)), 400


@app.get("/api/stats")
def database_stats():
    stats = get_stats()
    stats["psb_total"] = get_psb_stats()["total"]
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
    app.run(host=os.getenv("HOST", "127.0.0.1"), port=int(os.getenv("PORT", "8765")), debug=False)
