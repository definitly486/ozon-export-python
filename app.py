from __future__ import annotations

import csv
import io
import os
import webbrowser
from datetime import date
from flask import Flask, jsonify, render_template, request, send_file
from ozon_client import OzonClient, OzonApiError, CONFIRMED_STATUS
from ozon_storage import get_all_operations, get_stats, sync_operations

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


@app.get("/api/stats")
def database_stats():
    return jsonify(get_stats())


@app.post("/api/sync")
@app.post("/api/import")
def import_operations():
    payload = request.get_json(silent=True)
    if payload is None:
        return jsonify(error="Не удалось прочитать JSON-файл."), 400
    try:
        start = date.fromisoformat(request.args.get("start", ""))
        end = date.fromisoformat(request.args.get("end", ""))
    except ValueError:
        return jsonify(error="Укажите корректный период."), 400
    if start > end:
        return jsonify(error="Дата начала позже даты окончания."), 400

    try:
        sync_summary = sync_operations(payload)
        # Read the complete local history after upsert. This also means a
        # HOLD operation can become CONFIRMED on a later daily import.
        stored_items = get_all_operations()
        items, summary = OzonClient.convert_export_with_summary(stored_items, start, end)
        return jsonify(
            items=items,
            count=len(items),
            summary=summary,
            sync=sync_summary,
            database=get_stats(),
        )
    except (ValueError, OzonApiError) as exc:
        return jsonify(error=str(exc)), 400


@app.post("/api/export")
def export_csv():
    payload = request.get_json(silent=True) or {}
    selected = payload.get("items") if isinstance(payload, dict) else None
    if not isinstance(selected, list) or not selected:
        return jsonify(error="Нет выбранных операций."), 400

    output = io.StringIO(newline="")
    writer = csv.writer(output, delimiter=";", quoting=csv.QUOTE_MINIMAL, lineterminator="\r\n")
    writer.writerow(["Дата", "Название", "Цель", "Категория", "Дебет", "Кредит", "Итого"])
    exported = 0
    for row in selected:
        if not isinstance(row, dict) or row.get("status") != CONFIRMED_STATUS:
            continue
        writer.writerow([
            row.get("date_local", row.get("time", "")), row.get("name", ""),
            row.get("purpose", ""), row.get("category", ""),
            row.get("debit", ""), row.get("credit", ""), row.get("amount", ""),
        ])
        exported += 1

    if exported == 0:
        return jsonify(error="Нет подтверждённых операций для экспорта."), 400

    data = "\ufeff" + output.getvalue()
    return send_file(io.BytesIO(data.encode("utf-8")), mimetype="text/csv; charset=utf-8",
                     as_attachment=True, download_name=f"ozon_operations_{date.today().isoformat()}.csv")


if __name__ == "__main__":
    app.run(host=os.getenv("HOST", "127.0.0.1"), port=int(os.getenv("PORT", "8765")), debug=False)
