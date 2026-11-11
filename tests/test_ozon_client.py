import unittest
from datetime import date

from ozon_client import OzonClient, OzonApiError, CONFIRMED_STATUS, HOLD_STATUS


def operation(status=CONFIRMED_STATUS, sign="NEGATIVE", cents=1234):
    return {
        "status": status,
        "groupOperationType": "AUTHORIZATION",
        "time": "2026-11-11T12:00:00Z",
        "accountAmount": {
            "amountAbs": {"cents": cents, "currencyName": "RUR"},
            "sign": sign,
        },
        "purpose": "Test merchant",
        "lastOperationId": "test-operation-id",
    }


class OzonClientStatusTests(unittest.TestCase):
    def test_hold_is_visible_but_not_counted_as_confirmed(self):
        payload = {"items": [operation(HOLD_STATUS)]}
        rows, summary = OzonClient.convert_export_with_summary(
            payload, date(2026, 11, 11), date(2026, 11, 11)
        )
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["status"], HOLD_STATUS)
        self.assertEqual(rows[0]["amount"], -12.34)
        self.assertEqual(summary["hold"], 1)
        self.assertEqual(summary["confirmed"], 0)

    def test_confirmed_authorization_is_kept(self):
        payload = {"items": [operation()]}
        rows, summary = OzonClient.convert_export_with_summary(
            payload, date(2026, 11, 11), date(2026, 11, 11)
        )
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["amount"], -12.34)
        self.assertEqual(rows[0]["debit"], 12.34)
        self.assertEqual(rows[0]["status"], CONFIRMED_STATUS)
        self.assertEqual(summary["confirmed"], 1)

    def test_unknown_status_is_not_exported(self):
        payload = {"items": [operation("GROUP_OPERATION_PENDING")]}
        rows, summary = OzonClient.convert_export_with_summary(
            payload, date(2026, 11, 11), date(2026, 11, 11)
        )
        self.assertEqual(rows, [])
        self.assertEqual(summary["excluded_other"], 1)

    def test_unknown_amount_sign_fails_closed(self):
        with self.assertRaises(OzonApiError):
            OzonClient.convert_export(
                {"items": [operation(sign="UNKNOWN")]},
                date(2026, 11, 11),
                date(2026, 11, 11),
            )

    def test_positive_account_movement_is_credit(self):
        rows = OzonClient.convert_export(
            {"items": [operation(sign="POSITIVE")]},
            date(2026, 11, 11),
            date(2026, 11, 11),
        )
        self.assertEqual(rows[0]["amount"], 12.34)
        self.assertEqual(rows[0]["credit"], 12.34)
        self.assertEqual(rows[0]["debit"], 0)


if __name__ == "__main__":
    unittest.main()
