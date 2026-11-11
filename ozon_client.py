from __future__ import annotations

from datetime import date, datetime, time, timezone
from typing import Any


CONFIRMED_STATUS = "GROUP_OPERATION_CONFIRMED"
HOLD_STATUS = "GROUP_OPERATION_HOLD"


class OzonAuthError(RuntimeError):
    pass


class OzonApiError(RuntimeError):
    pass


class OzonClient:
    """Converts operations exported from the user's ordinary Firefox session.

    Only confirmed account movements are returned for the money CSV.
    Holds and other non-confirmed states remain in the source JSON but are
    excluded from the transaction list.
    """

    @staticmethod
    def _parse_time(value: str) -> datetime:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)

    @staticmethod
    def _to_transaction(item: dict[str, Any]) -> dict[str, Any]:
        account_amount = item.get("accountAmount")
        if not isinstance(account_amount, dict):
            raise OzonApiError("В операции отсутствует сумма по счёту (accountAmount).")

        amount_abs = account_amount.get("amountAbs")
        if not isinstance(amount_abs, dict) or not isinstance(amount_abs.get("cents"), int):
            raise OzonApiError("В операции некорректная сумма по счёту.")

        cents = amount_abs["cents"]
        if cents < 0:
            raise OzonApiError("Сумма accountAmount должна быть абсолютной величиной.")

        sign = str(account_amount.get("sign") or "").upper()
        if sign == "NEGATIVE":
            negative = True
        elif sign == "POSITIVE":
            negative = False
        else:
            raise OzonApiError(f"Неизвестный знак суммы операции: {sign or 'не указан'}.")

        currency = amount_abs.get("currencyName") or ""
        if currency != "RUR":
            raise OzonApiError(
                f"Неподдерживаемая валюта операции: {currency or 'не указана'}. "
                "Экспорт остановлен, чтобы не смешивать разные валюты в одном CSV."
            )

        base = cents / 100
        amount = -base if negative else base
        name = (
            (item.get("merchant") or {}).get("name")
            or (item.get("cardMerchant") or {}).get("name")
            or item.get("counterpartyName")
            or item.get("purpose")
            or item.get("categoryGroupName")
            or ""
        )
        purpose = item.get("purpose") or ""
        if item.get("comment"):
            purpose += f": {item['comment']}"

        raw_time = item.get("time", "")
        try:
            local_time = OzonClient._parse_time(raw_time).astimezone().strftime("%Y-%m-%d %H:%M:%S")
        except (ValueError, TypeError):
            local_time = raw_time

        return {
            "time": raw_time,
            "date_local": local_time,
            "name": name,
            "category": item.get("categoryGroupName") or "",
            "purpose": purpose,
            "debit": base if negative else 0,
            "credit": 0 if negative else base,
            "amount": amount,
            # Keep provenance in the in-memory row; the CSV contains only
            # confirmed movements, and the export endpoint checks this again.
            "status": item.get("status"),
            "operation_type": item.get("groupOperationType") or "",
            "operation_id": item.get("lastOperationId") or "",
        }

    @classmethod
    def convert_export_with_summary(
        cls, payload: Any, start_date: date, end_date: date
    ) -> tuple[list[dict[str, Any]], dict[str, int]]:
        # Accept either the direct list or the GraphQL-like response exported by the bookmarklet.
        if isinstance(payload, list):
            items = payload
        elif isinstance(payload, dict):
            items = payload.get("items")
            if items is None:
                data = payload.get("data") or {}
                me = data.get("me") or {}
                client = me.get("client") or {}
                group = client.get("groupOperationsV3") or {}
                items = group.get("items")
        else:
            items = None

        if not isinstance(items, list):
            raise OzonApiError(
                "В JSON-файле не найден список операций. Скачайте файл повторно из личного кабинета."
            )

        summary = {"confirmed": 0, "excluded_hold": 0, "excluded_other": 0}
        transactions: list[dict[str, Any]] = []

        for item in items:
            if not isinstance(item, dict):
                continue
            try:
                operation_time = cls._parse_time(item.get("time", ""))
            except (ValueError, TypeError):
                continue

            # The date controls in the UI are calendar dates in the computer's
            # local timezone, matching the date shown in the operations table.
            if not start_date <= operation_time.astimezone().date() <= end_date:
                continue

            status = item.get("status")
            if status != CONFIRMED_STATUS:
                if status == HOLD_STATUS:
                    summary["excluded_hold"] += 1
                else:
                    summary["excluded_other"] += 1
                continue

            transactions.append(cls._to_transaction(item))
            summary["confirmed"] += 1

        transactions.sort(key=lambda row: row.get("time", ""), reverse=True)
        return transactions, summary

    @classmethod
    def convert_export(cls, payload: Any, start_date: date, end_date: date) -> list[dict[str, Any]]:
        """Backward-compatible helper returning confirmed transactions only."""
        transactions, _summary = cls.convert_export_with_summary(payload, start_date, end_date)
        return transactions
