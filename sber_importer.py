from __future__ import annotations

import hashlib
import re
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from pypdf import PdfReader
from ozon_client import CONFIRMED_STATUS


class SberStatementError(ValueError):
    """Raised when a Sberbank PDF statement cannot be parsed safely."""


HEADER = re.compile(r"ДАТА ОПЕРАЦИИ", re.IGNORECASE)
ROW = re.compile(
    r"^\s*(\d{2}\.\d{2}\.\d{4})\s+(\d{2}:\d{2})\s+(.+?)\s+([+]?\d[\d\s\u00a0]*,\d{2})\s+([\d\s\u00a0]+,\d{2})\s*$"
)
DETAIL = re.compile(r"^\s*(\d{2}\.\d{2}\.\d{4})\s+(\d{6})\s+(.+?)\s*$")
MONEY = re.compile(r"^[+]?\d[\d\s\u00a0]*,\d{2}$")


def _amount(value: str) -> Decimal:
    try:
        return Decimal(value.replace("\u00a0", "").replace(" ", "").replace(",", ".").replace("+", ""))
    except InvalidOperation:
        raise SberStatementError(f"Некорректная сумма в PDF: {value!r}") from None


def extract_pdf_text(content: bytes) -> str:
    if not content.startswith(b"%PDF"):
        raise SberStatementError("Выбранный файл не является PDF-выпиской.")
    try:
        from io import BytesIO
        reader = PdfReader(BytesIO(content))
        if reader.is_encrypted:
            raise SberStatementError("PDF защищён паролем. Сохраните выписку без пароля и повторите импорт.")
        pages = [page.extract_text() or "" for page in reader.pages]
    except SberStatementError:
        raise
    except Exception as exc:
        raise SberStatementError(f"Не удалось прочитать PDF: {exc}") from exc
    text = "\n".join(pages)
    if not HEADER.search(text):
        raise SberStatementError("Не найдена таблица операций Сбербанка. Нужна выписка по счёту дебетовой карты.")
    return text


def parse_sber_pdf(content: bytes) -> list[dict[str, Any]]:
    text = extract_pdf_text(content)
    lines = [line.rstrip() for line in text.splitlines()]
    operations: list[dict[str, Any]] = []
    pending = None

    def save_pending():
        nonlocal pending
        if not pending:
            return
        amount = _amount(pending["amount_text"])
        dt = datetime.strptime(pending["date"] + " " + pending["time"], "%d.%m.%Y %H:%M")
        details = pending["details"].strip()
        if not details:
            raise SberStatementError(f"Не найдено описание операции от {pending['date']}.")
        fingerprint = "\x1f".join((dt.isoformat(timespec="minutes"), pending["processing_date"], pending["auth"], pending["category"], str(amount), pending["balance"], details))
        operation_id = hashlib.sha256(fingerprint.encode("utf-8")).hexdigest()
        operations.append({
            "operation_id": operation_id,
            "time": dt.isoformat(timespec="minutes"),
            "date_local": dt.strftime("%Y-%m-%d %H:%M"),
            "auth_code": pending["auth"],
            "processing_date": datetime.strptime(pending["processing_date"], "%d.%m.%Y").date().isoformat(),
            "category": pending["category"],
            "details": details,
            "amount": str(amount if pending["amount_text"].lstrip().startswith("+") else -amount),
            "balance": str(_amount(pending["balance"])),
            "currency": "RUB",
        })
        pending = None

    for line in lines:
        match = ROW.match(line)
        if match:
            save_pending()
            pending = {
                "date": match.group(1), "time": match.group(2),
                "category": match.group(3).strip(), "amount_text": match.group(4).strip(),
                "balance": match.group(5).strip(), "auth": "", "processing_date": "", "details": "",
            }
            continue
        detail = DETAIL.match(line)
        if detail and pending:
            pending["processing_date"] = detail.group(1)
            pending["auth"] = detail.group(2)
            pending["details"] += detail.group(3).strip()
            continue
        if pending and pending["auth"] and line.strip():
            stripped = line.strip()
            if not re.search(r"Страница \d+ из \d+|Продолжение на следующей странице|ДАТА ОПЕРАЦИИ|Дата обработки|Описание операции|и код авторизации|В валюте счёта|Выписка по счёту|Для проверки подлинности", stripped, re.I):
                pending["details"] += " " + stripped
    save_pending()
    if not operations:
        raise SberStatementError("В PDF не найдено ни одной операции. Возможно, формат выписки отличается.")
    return operations


def convert_sber_operations(operations: list[dict[str, Any]], start_date, end_date) -> list[dict[str, Any]]:
    transactions = []
    for item in operations:
        try:
            dt = datetime.fromisoformat(str(item["time"]))
            amount = Decimal(str(item["amount"]))
        except (KeyError, ValueError, InvalidOperation):
            continue
        if not start_date <= dt.date() <= end_date:
            continue
        details = str(item.get("details") or "").strip()
        transactions.append({
            "time": dt.isoformat(timespec="minutes"),
            "date_local": dt.strftime("%Y-%m-%d %H:%M"),
            "name": details,
            "category": str(item.get("category") or ""),
            "purpose": details,
            "debit": float(abs(amount)) if amount < 0 else 0,
            "credit": float(abs(amount)) if amount > 0 else 0,
            "amount": float(amount),
            "status": CONFIRMED_STATUS,
            "operation_type": "SBER",
            "operation_id": item.get("operation_id", ""),
            "source": "Сбербанк",
            "balance": item.get("balance", ""),
        })
    transactions.sort(key=lambda row: row["time"], reverse=True)
    return transactions
