from __future__ import annotations

from flask import Blueprint, jsonify, render_template, request

from receipts_storage import get_receipts, get_receipt_stats, sync_receipts

receipts_bp = Blueprint("receipts", __name__)


@receipts_bp.get("/receipts")
def receipts_page():
    return render_template("receipts.html")


@receipts_bp.get("/api/receipts")
def list_receipts():
    return jsonify(items=get_receipts(), stats=get_receipt_stats())


@receipts_bp.post("/api/receipts/import")
def import_receipts():
    payload = request.get_json(silent=True)
    if payload is None:
        return jsonify(error="Не удалось прочитать JSON-выгрузку чеков."), 400
    try:
        sync = sync_receipts(payload)
        return jsonify(ok=True, sync=sync, stats=get_receipt_stats())
    except (ValueError, TypeError) as exc:
        return jsonify(error=str(exc)), 400
