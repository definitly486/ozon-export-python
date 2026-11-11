from __future__ import annotations

import csv
import hashlib
import io
import re
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from ozon_client import CONFIRMED_STATUS


class PsbStatementError(ValueError):
    """Raised when a PSB statement cannot be parsed safely."""


HEADER = "Дата и время транзакции"
REQUIRED_COLUMNS = {
    "Дата и время транзакции",
    "Дата обработки транзакции",
    "Детали",
    "Сумма",
    "Сумма в валюте карты",
}


def _decimal(value: str, field: str) -> Decimal:
    normalized = (value or "").strip().replace("\u00a0", "").replace(" ", "").replace(",", ".")
    try:
        return Decimal(normalized)
    except (InvalidOperation, ValueError):
        raise PsbStatementError(f"В выписке ПСБ некорректное значение в поле «{field}»: {value!r}.") from None


def _money_text(value: Decimal) -> str:
    return format(value, "f")


def _merchant(details: str) -> str:
    value = re.sub(r"^\s*\S+\s+", "", details or "")
    value = re.sub(r"^(Покупка|Безналичное списание|Зачисление)\s+", "", value, flags=re.IGNORECASE)
    value = re.sub(r"\s*MCC\s*\d+\s*$", "", value, flags=re.IGNORECASE)
    value = re.sub(r"\s+\d{6,}\.?\s*$", "", value)
    return value.strip() or (details or "").strip()
def parse_psb_csv(content: str | bytes) -> list[dict[str, Any]]:
    """Parse the semicolon-delimited CSV exported by PSB personal banking."""
    if isinstance(content, bytes):
        try:
            content = content.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            raise PsbStatementError("Не удалось прочитать CSV ПСБ в кодировке UTF-8.") from exc
    content = content.lstrip("\ufeff")
    rows = list(csv.reader(io.StringIO(content, newline=""), delimiter=";"))
    header_index = next((i for i, row in enumerate(rows) if row and row[0].strip().strip('"') == HEADER), None)
    if header_index is None:
        raise PsbStatementError("Не найдена таблица операций ПСБ. Нужна CSV-выписка из личного кабинета.")
    headers = [cell.strip().strip('"') for cell in rows[header_index]]
    missing = REQUIRED_COLUMNS.difference(headers)
    if missing:
        raise PsbStatementError("В выписке ПСБ отсутствуют столбцы: " + ", ".join(sorted(missing)))
    indexes = {name: headers.index(name) for name in REQUIRED_COLUMNS}

    currency = "RUR"
    for row in rows[:header_index]:
        if len(row) >= 3 and row[0].strip().strip('"') == "Входящий остаток":
            currency = row[2].strip().strip('"') or currency
            break
    if currency not in {"RUR", "RUB"}:
        raise PsbStatementError(f"Валюта выписки {currency!r} пока не поддерживается. Импорт остановлен.")

    operations: list[dict[str, Any]] = []
    for line_number, row in enumerate(rows[header_index + 1 :], start=header_index + 2):
        if not row or not any(cell.strip() for cell in row):
            continue
        try:
            raw_time = row[indexes["Дата и время транзакции"]].strip()
            operation_time = datetime.strptime(raw_time, "%d.%m.%Y %H:%M:%S")
            processing_date = datetime.strptime(
                row[indexes["Дата обработки транзакции"]].strip(), "%d.%m.%Y"
            ).date().isoformat()
            details = row[indexes["Детали"]].strip()
            amount_text = row[indexes["Сумма"]].strip()
            card_amount_text = row[indexes["Сумма в валюте карты"]].strip()
            amount = _decimal(card_amount_text or amount_text, "Сумма в валюте карты" if card_amount_text else "Сумма")
        except (IndexError, ValueError, PsbStatementError) as exc:
            raise PsbStatementError(f"Не удалось разобрать строку {line_number}: {exc}") from exc

        if not details:
            raise PsbStatementError(f"В строке {line_number} отсутствует описание операции.")
        # The PSB export has no dedicated transaction ID. This fingerprint is
        # stable across overlapping statements and does not include account data.
        fingerprint = "\x1f".join((raw_time, processing_date, details, _money_text(amount), currency))
        operation_id = hashlib.sha256(fingerprint.encode("utf-8")).hexdigest()
        mcc_match = re.search(r"\bMCC\s*(\d+)", details, flags=re.IGNORECASE)
        operations.append({
            "operation_id": operation_id,
            "time": operation_time.isoformat(timespec="seconds"),
            "processing_date": processing_date,
            "details": details,
            "amount": _money_text(amount),
            "currency": currency,
            "mcc": mcc_match.group(1) if mcc_match else "",
        })
    if not operations:
        raise PsbStatementError("В выписке ПСБ не найдено ни одной операции.")
    return operations


def convert_psb_operations(
    operations: list[dict[str, Any]], start_date, end_date
) -> list[dict[str, Any]]:
    transactions = []
    for item in operations:
        try:
            operation_time = datetime.fromisoformat(str(item["time"]))
            amount = Decimal(str(item["amount"]))
        except (KeyError, ValueError, InvalidOperation):
            continue
        # PSB statement periods are based on the processing date. A purchase
        # made before the selected period can still be posted inside it.
        try:
            statement_date = date.fromisoformat(str(item.get("processing_date") or operation_time.date().isoformat()))
        except ValueError:
            statement_date = operation_time.date()
        if not start_date <= statement_date <= end_date:
            continue
        base = abs(amount)
        details = str(item.get("details") or "")
        transactions.append({
            "time": operation_time.isoformat(timespec="seconds"),
            "date_local": operation_time.strftime("%Y-%m-%d %H:%M:%S"),
            "name": _merchant(details),
            "category": f"MCC {item['mcc']}" if item.get("mcc") else "",
            "purpose": details,
            "debit": float(base) if amount < 0 else 0,
            "credit": float(base) if amount > 0 else 0,
            "amount": float(amount),
            "status": CONFIRMED_STATUS,
            "operation_type": "PSB",
            "operation_id": item.get("operation_id", ""),
            "source": "ПСБ",
        })
    transactions.sort(key=lambda row: row["time"], reverse=True)
    return transactions
