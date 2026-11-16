import tempfile
import unittest
from pathlib import Path

from receipts_storage import get_receipts, get_receipt_stats, sync_receipts


def sample_receipt(total='1299'):
    return {
        'receipt': {'key': 'receipt-key-1', 'createdDate': '2026-11-13T04:48:00Z',
                    'totalSum': total, 'kktOwner': 'Example Seller',
                    'kktOwnerInn': '7700000000', 'fiscalDocumentNumber': '12345'},
        'fiscalData': {'dateTime': '2026-11-13T04:47:00Z', 'totalSum': int(total),
                       'user': 'Example Seller LLC', 'userInn': '7700000000',
                       'items': [{'name': 'Test item', 'quantity': 2, 'price': 500,
                                  'sum': 1000, 'nds': '20%'}]},
    }


class ReceiptStorageTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / 'receipts.sqlite3'

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_import_and_repeat_are_idempotent(self):
        payload = {'exportedAt': '2026-11-13T04:48:00Z', 'listComplete': True,
                   'detailsComplete': True, 'receipts': [sample_receipt()]}
        first = sync_receipts(payload, self.db_path)
        second = sync_receipts(payload, self.db_path)
        self.assertEqual(first['new'], 1)
        self.assertEqual(second['unchanged'], 1)
        self.assertEqual(len(get_receipts(self.db_path)), 1)
        self.assertTrue(get_receipt_stats(self.db_path)['details_complete'])

    def test_changed_receipt_updates_existing_record(self):
        sync_receipts({'receipts': [sample_receipt()]}, self.db_path)
        result = sync_receipts({'receipts': [sample_receipt('1500')]}, self.db_path)
        self.assertEqual(result['updated'], 1)
        self.assertEqual(get_receipts(self.db_path)[0]['receipt']['totalSum'], '1500')

    def test_invalid_payload_is_rejected(self):
        with self.assertRaises(ValueError):
            sync_receipts({'items': []}, self.db_path)


if __name__ == '__main__':
    unittest.main()
