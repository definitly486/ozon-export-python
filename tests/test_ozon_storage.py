import tempfile
import unittest
from pathlib import Path

from ozon_storage import get_all_operations, get_stats, sync_operations


def operation(status="GROUP_OPERATION_HOLD", operation_id="op-1", purpose="Purchase"):
    return {
        "lastOperationId": operation_id,
        "time": "2026-11-11T12:00:00Z",
        "status": status,
        "purpose": purpose,
    }


class OzonStorageTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "operations.sqlite3"

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_first_sync_inserts_operations(self):
        result = sync_operations({"items": [operation()]}, self.db_path)
        self.assertEqual(result["new"], 1)
        self.assertEqual(result["updated"], 0)
        self.assertEqual(len(get_all_operations(self.db_path)), 1)

    def test_repeated_sync_does_not_create_duplicates(self):
        payload = {"items": [operation()]}
        sync_operations(payload, self.db_path)
        result = sync_operations(payload, self.db_path)
        self.assertEqual(result["new"], 0)
        self.assertEqual(result["updated"], 0)
        self.assertEqual(result["unchanged"], 1)
        self.assertEqual(get_stats(self.db_path)["total"], 1)

    def test_hold_is_updated_when_operation_becomes_confirmed(self):
        sync_operations({"items": [operation()]}, self.db_path)
        result = sync_operations(
            {"items": [operation("GROUP_OPERATION_CONFIRMED")]}, self.db_path
        )
        rows = get_all_operations(self.db_path)
        self.assertEqual(result["updated"], 1)
        self.assertEqual(rows[0]["status"], "GROUP_OPERATION_CONFIRMED")
        self.assertEqual(get_stats(self.db_path)["confirmed"], 1)
        self.assertEqual(get_stats(self.db_path)["hold"], 0)

    def test_changed_description_updates_existing_operation(self):
        sync_operations({"items": [operation(purpose="Old description")]}, self.db_path)
        result = sync_operations(
            {"items": [operation(purpose="New description")]}, self.db_path
        )
        self.assertEqual(result["updated"], 1)
        self.assertEqual(get_all_operations(self.db_path)[0]["purpose"], "New description")

    def test_payload_without_operation_ids_is_rejected(self):
        with self.assertRaises(ValueError):
            sync_operations({"items": [{"status": "GROUP_OPERATION_CONFIRMED"}]}, self.db_path)
        self.assertEqual(get_stats(self.db_path)["total"], 0)


if __name__ == "__main__":
    unittest.main()
