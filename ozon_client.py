from __future__ import annotations

from datetime import date, datetime, time, timezone
from typing import Any


class OzonAuthError(RuntimeError):
    pass


class OzonApiError(RuntimeError):
    pass


class OzonClient:
    """Converts operations exported from the user's ordinary Firefox session.

    No WebDriver, browser automation, proxy, or credentials are used. The user
    runs a bookmarklet on finance.ozon.ru; it downloads the response JSON, which
    is then imported into this local application.
    """

    @staticmethod
    def _parse_time(value: str) -> datetime:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)

    @staticmethod
    def _to_transaction(item: dict[str, Any]) -> dict[str, Any]:
        account_amount = item.get("accountAmount") or {}
        amount_abs = account_amount.get("amountAbs") or {}
        cents = amount_abs.get("cents") or 0
        base = cents / 100
        sign = str(account_amount.get("sign") or "").upper()
        negative = any(token in sign for token in ("NEG", "MINUS")) or sign in ("-", "SIGN_MINUS")
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
            # A negative account movement is an expense (debit); a positive
            # movement is an incoming credit.
            "debit": base if negative else 0,
            "credit": 0 if negative else base,
            "amount": amount,
        }

    @classmethod
    def convert_export(cls, payload: Any, start_date: date, end_date: date) -> list[dict[str, Any]]:
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
            raise OzonApiError("В JSON-файле не найден список операций. Скачайте файл повторно из личного кабинета.")

        start_utc = datetime.combine(start_date, time.min, tzinfo=timezone.utc)
        end_utc = datetime.combine(end_date, time.max, tzinfo=timezone.utc)
        transactions: list[dict[str, Any]] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            try:
                operation_time = cls._parse_time(item.get("time", ""))
            except (ValueError, TypeError):
                continue
            if start_utc <= operation_time <= end_utc:
                transactions.append(cls._to_transaction(item))
        transactions.sort(key=lambda row: row.get("time", ""), reverse=True)
        return transactions
