"""Simple JSON file-based state persistence."""

import json
import os
from datetime import datetime, timezone


DEFAULT_STATE_PATH = os.path.join(os.path.dirname(__file__), "state.json")

# Max chars to store per source snapshot. Keeps state.json under ~2MB for 93 sources.
# Changelogs prepend new entries at top, so truncating from end is safe.
MAX_SNAPSHOT_CHARS = 20000


def load_state(path=DEFAULT_STATE_PATH):
    """Load state from JSON file. Returns empty dict if file doesn't exist."""
    if not os.path.exists(path):
        return {}
    with open(path, "r") as f:
        return json.load(f)


def save_state(state, path=DEFAULT_STATE_PATH):
    """Write state to JSON file."""
    with open(path, "w") as f:
        json.dump(state, f, indent=2, sort_keys=True)


def now_iso():
    """Return current UTC timestamp as ISO string."""
    return datetime.now(timezone.utc).isoformat()


def make_state_entry(content_hash: str, text: str) -> dict:
    """Create a state entry with truncated snapshot."""
    return {
        "content_hash": content_hash,
        "text_snapshot": text[:MAX_SNAPSHOT_CHARS],
        "last_check": now_iso(),
    }
