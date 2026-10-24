#!/usr/bin/env python3
"""Identify the ordered database migrations shipped in an Orbis release."""

import hashlib
import json
import re
from pathlib import Path


def fingerprint(root: Path) -> str:
    journal = json.loads((root / "meta/_journal.json").read_text())
    entries = journal.get("entries")
    if journal.get("dialect") != "postgresql" or not isinstance(entries, list) or not 1 <= len(entries) <= 4096:
        raise ValueError("invalid migration journal")
    ledger = []
    previous = 0
    for index, entry in enumerate(entries):
        if entry.get("idx") != index or type(entry.get("when")) is not int or not previous < entry["when"] <= 2**53 - 1 or not re.fullmatch(r"[0-9]{4}_[A-Za-z0-9_-]+", entry.get("tag", "")):
            raise ValueError("invalid migration entry")
        previous = entry["when"]
        ledger.append({"createdAt": previous, "hash": hashlib.sha256((root / (entry["tag"] + ".sql")).read_bytes()).hexdigest()})
    return "sha256:" + hashlib.sha256(json.dumps(ledger, separators=(",", ":")).encode()).hexdigest()


if __name__ == "__main__":
    print(fingerprint(Path(__file__).resolve().parent.parent / "packages/backend/src/core/database/drizzle"))
