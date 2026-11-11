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
OZON_URL = "https://finance.ozon.ru/lk"


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
        "confirmed": len(items),
        "excluded_hold": ozon_summary["excluded_hold"],
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
