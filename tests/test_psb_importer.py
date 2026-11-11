import tempfile
import unittest
from datetime import date
from pathlib import Path

from psb_importer import PsbStatementError, convert_psb_operations, parse_psb_csv
from psb_storage import get_all_psb_operations, sync_psb_operations


SAMPLE = """\ufeff"Номер контракта";"30024-P-000000"
"Дата начала выписки";01.10.2026
"Дата окончания выписки";11.11.2026
"Входящий остаток";36,24;RUR
"Суммарный приход";3267,36;RUR
"Суммарный расход";3049,56;RUR
"Исходящий остаток";254,04;RUR
"Дата и время транзакции";"Дата обработки транзакции";"Детали";"Сумма";"Сумма в валюте карты"
01.10.2026 21:56:34;01.10.2026;"220003..2782 Зачисление PSBRETAIL 000106. MCC 6536";1332,59;1332,59
02.10.2026 14:24:05;02.10.2026;"220003..2782 Покупка RUS MOSCOW PYATEROCHKA 000108. MCC 5411";75,00;-75,00
"""


class PsbImporterTests(unittest.TestCase):
    def test_parse_metadata_and_signed_card_amount(self):
        rows = parse_psb_csv(SAMPLE)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["amount"], "1332.59")
        self.assertEqual(rows[1]["amount"], "-75.00")
        self.assertEqual(rows[1]["mcc"], "5411")

    def test_convert_direction_and_date_filter(self):
        rows = convert_psb_operations(parse_psb_csv(SAMPLE), date(2026, 10, 1), date(2026, 10, 2))
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["credit"], 1332.59)
        self.assertEqual(rows[1]["debit"], 75.0)
        self.assertEqual(rows[1]["source"], "ПСБ")

    def test_rejects_wrong_csv(self):
        with self.assertRaises(PsbStatementError):
            parse_psb_csv("not a PSB statement")

    def test_overlapping_import_is_deduplicated(self):
        with tempfile.TemporaryDirectory() as temp:
            db = Path(temp) / "bank.sqlite3"
            parsed = parse_psb_csv(SAMPLE)
            first = sync_psb_operations(parsed, db)
            second = sync_psb_operations(parsed, db)
            self.assertEqual(first["new"], 2)
            self.assertEqual(second["new"], 0)
            self.assertEqual(second["unchanged"], 2)
            self.assertEqual(len(get_all_psb_operations(db)), 2)


if __name__ == "__main__":
    unittest.main()
