from __future__ import annotations

import hashlib
import logging
import os
import re
import threading
import time
from pathlib import Path

from psb_importer import parse_psb_csv, PsbStatementError
from psb_storage import get_psb_stats, sync_psb_operations

logger = logging.getLogger(__name__)
MAX_CSV_BYTES = 20 * 1024 * 1024
POLL_SECONDS = 2.0
STABLE_POLLS = 2


def _download_directory() -> Path:
    """Resolve the user's XDG Downloads directory, falling back to ~/Downloads."""
    configured = os.environ.get("XDG_DOWNLOAD_DIR")
    if not configured:
        config_file = Path.home() / ".config" / "user-dirs.dirs"
        try:
            text = config_file.read_text(encoding="utf-8")
            match = re.search(r'^XDG_DOWNLOAD_DIR="(.*)"$', text, re.MULTILINE)
            if match:
                configured = match.group(1).replace("$HOME", str(Path.home()))
        except OSError:
            pass
    path = Path(configured).expanduser() if configured else Path.home() / "Downloads"
    return path.resolve()


def _is_psb_csv(path: Path) -> bool:
    if path.suffix.lower() != ".csv" or not path.is_file():
        return False
    try:
        if path.stat().st_size > MAX_CSV_BYTES:
            logger.warning("PSB watcher skipped oversized CSV: %s", path.name)
            return False
        with path.open("rb") as stream:
            sample = stream.read(256 * 1024)
        return "Дата и время транзакции" in sample.decode("utf-8-sig", errors="ignore")
    except OSError:
        return False


def watch_psb_downloads(stop_event: threading.Event | None = None) -> None:
    """Import only newly appearing, stable PSB CSV files from Downloads."""
    stop_event = stop_event or threading.Event()
    directory = _download_directory()
    if not directory.is_dir():
        logger.info("PSB Downloads watcher is waiting for directory: %s", directory)
        while not directory.is_dir() and not stop_event.wait(POLL_SECONDS):
            pass
    if stop_event.is_set():
        return

    # Existing files are deliberately treated as old: only downloads created
    # or changed after application startup are imported automatically.
    known = {}
    for path in directory.glob("*.csv"):
        try:
            stat = path.stat()
            known[path.resolve()] = (stat.st_size, stat.st_mtime_ns)
        except OSError:
            continue

    stable_counts: dict[Path, int] = {}
    attempted: set[tuple[str, int, int]] = set()
    logger.info("PSB Downloads watcher started: %s", directory)

    while not stop_event.wait(POLL_SECONDS):
        try:
            paths = list(directory.glob("*.csv"))
        except OSError as exc:
            logger.warning("Cannot scan PSB Downloads directory: %s", exc)
            continue

        present = set()
        for path in paths:
            try:
                resolved = path.resolve(strict=True)
                # Do not follow symlinks outside the Downloads directory.
                resolved.relative_to(directory)
                stat = resolved.stat()
            except (OSError, ValueError):
                continue
            present.add(resolved)
            signature = (stat.st_size, stat.st_mtime_ns)
            previous = known.get(resolved)
            if previous != signature:
                known[resolved] = signature
                stable_counts[resolved] = 1
                continue
            stable_counts[resolved] = stable_counts.get(resolved, 0) + 1
            if stable_counts[resolved] < STABLE_POLLS:
                continue
            if stat.st_size <= 0 or stat.st_size > MAX_CSV_BYTES:
                continue
            if not _is_psb_csv(resolved):
                continue

            try:
                content = resolved.read_bytes()
                digest = hashlib.sha256(content).hexdigest()
                attempt_key = (digest, stat.st_size, stat.st_mtime_ns)
                if attempt_key in attempted:
                    continue
                attempted.add(attempt_key)
                operations = parse_psb_csv(content)
                summary = sync_psb_operations(operations)
                logger.info(
                    "Automatically imported PSB CSV %s: new=%s unchanged=%s total=%s",
                    resolved.name, summary.get("new", 0),
                    summary.get("unchanged", 0), get_psb_stats()["total"],
                )
            except (OSError, PsbStatementError, ValueError) as exc:
                logger.warning("PSB CSV import failed for %s: %s", resolved.name, exc)
            finally:
                stable_counts.pop(resolved, None)

        for path in list(known):
            if path not in present:
                known.pop(path, None)
                stable_counts.pop(path, None)


def start_psb_download_watcher() -> threading.Thread:
    thread = threading.Thread(
        target=watch_psb_downloads,
        name="psb-download-watcher",
        daemon=True,
    )
    thread.start()
    return thread
