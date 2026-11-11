from __future__ import annotations

import csv
import io
import os
import webbrowser
from datetime import date
from flask import Flask, jsonify, render_template, request, send_file
from ozon_client import OzonClient, OzonApiError

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


@app.post("/api/import")
def import_operations():
    payload = request.get_json(silent=True)
    if payload is None:
        return jsonify(error="Не удалось прочитать JSON-файл."), 400
    try:
        start = date.fromisoformat(request.args.get("start", ""))
        end = date.fromisoformat(request.args.get("end", ""))
        if start > end:
            return jsonify(error="Дата начала позже даты окончания."), 400
        items = OzonClient.convert_export(payload, start, end)
        return jsonify(items=items, count=len(items))
    except ValueError:
        return jsonify(error="Укажите корректный период."), 400
    except OzonApiError as exc:
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
    for row in selected:
        if not isinstance(row, dict):
            continue
        writer.writerow([
            row.get("date_local", row.get("time", "")), row.get("name", ""),
            row.get("purpose", ""), row.get("category", ""),
            row.get("debit", ""), row.get("credit", ""), row.get("amount", ""),
        ])
    data = "\ufeff" + output.getvalue()
    return send_file(io.BytesIO(data.encode("utf-8")), mimetype="text/csv; charset=utf-8",
                     as_attachment=True, download_name=f"ozon_operations_{date.today().isoformat()}.csv")


if __name__ == "__main__":
    app.run(host=os.getenv("HOST", "127.0.0.1"), port=int(os.getenv("PORT", "8765")), debug=False)
