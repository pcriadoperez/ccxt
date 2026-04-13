#!/usr/bin/env python3
"""Exchange Changelog Monitor — Main CLI.

Usage:
    python monitor.py run [--dry-run]    Full pipeline: fetch, diff, analyze, create issues
    python monitor.py seed               Save baseline state (no issues created)
    python monitor.py check <exchange>   Test a single exchange (no state/issues)
"""

import argparse
import hashlib
import json
import os
import re
import sys
import time

import yaml

from state import load_state, save_state, make_state_entry
from fetcher import fetch_all_changelogs, fetch_exchange_urls
from agent import analyze_changelog_diff


# --- Config ---

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
EXCHANGES_YAML = os.path.join(SCRIPT_DIR, "exchanges.yaml")
CCXT_INIT_PATH = os.path.join(SCRIPT_DIR, "..", "python", "ccxt", "__init__.py")
TARGET_REPO = os.environ.get("TARGET_REPO", "pcriadoperez/ccxt")
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")
DRY_RUN = os.environ.get("DRY_RUN", "false").lower() == "true"

# Delay between GitHub API calls to avoid rate limiting (30 req/min for search)
GITHUB_API_DELAY = 2.0  # seconds


# --- Helpers ---

def load_exchanges():
    """Load exchanges.yaml config."""
    with open(EXCHANGES_YAML, "r") as f:
        return yaml.safe_load(f) or {}


def sha256(text: str) -> str:
    """SHA-256 hash of text content."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def get_ccxt_exchange_list() -> list[str]:
    """Parse exchange IDs from CCXT's Python __init__.py."""
    if not os.path.exists(CCXT_INIT_PATH):
        print(f"WARNING: CCXT init not found at {CCXT_INIT_PATH}")
        return []
    with open(CCXT_INIT_PATH, "r") as f:
        content = f.read()
    match = re.search(r"exchanges\s*=\s*\[(.*?)\]", content, re.DOTALL)
    if not match:
        return []
    return re.findall(r"'(\w+)'", match.group(1))


def get_exchange_urls(config: dict) -> list[dict]:
    """Get the list of changelog URLs from an exchange config."""
    return config.get("changelog_urls", [])


# --- GitHub API ---

_last_github_call = 0.0


def _rate_limit():
    """Enforce minimum delay between GitHub API calls."""
    global _last_github_call
    elapsed = time.time() - _last_github_call
    if elapsed < GITHUB_API_DELAY:
        time.sleep(GITHUB_API_DELAY - elapsed)
    _last_github_call = time.time()


def github_api(method: str, endpoint: str, data=None) -> dict | list | None:
    """Make a GitHub API request with rate limiting."""
    import urllib.request
    import urllib.error

    _rate_limit()

    url = f"https://api.github.com{endpoint}"
    headers = {
        "Authorization": f"token {GITHUB_TOKEN}",
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "ccxt-changelog-monitor",
    }
    if data is not None:
        headers["Content-Type"] = "application/json"
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        print(f"  GitHub API error: {e.code} {e.reason}")
        try:
            print(f"  Response: {e.read().decode()[:200]}")
        except Exception:
            pass
        return None
    except Exception as e:
        print(f"  GitHub API error: {e}")
        return None


def ensure_label(name: str, color: str = "d4c5f9", description: str = ""):
    """Create a label if it doesn't exist. Silently ignores 422 (already exists)."""
    import urllib.request
    import urllib.error

    if not GITHUB_TOKEN:
        return

    _rate_limit()

    url = f"https://api.github.com/repos/{TARGET_REPO}/labels"
    headers = {
        "Authorization": f"token {GITHUB_TOKEN}",
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "ccxt-changelog-monitor",
        "Content-Type": "application/json",
    }
    body = json.dumps({"name": name, "color": color, "description": description}).encode()
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        urllib.request.urlopen(req)
    except urllib.error.HTTPError:
        pass  # 422 = already exists, other errors are non-fatal


# Label cache so we only create each label once per run
_ensured_labels: set[str] = set()


def ensure_labels(labels: list[str]):
    """Ensure all labels exist in the repo, creating if needed."""
    for label in labels:
        if label in _ensured_labels:
            continue
        color = "e11d48" if label == "breaking" else (
            "f59e0b" if label == "needs-review" else (
            "6366f1" if label == "changelog-monitor" else "d4c5f9"
        ))
        ensure_label(label, color)
        _ensured_labels.add(label)


def search_github_issues(exchange_id: str) -> list[str]:
    """Search for existing changelog-monitor issues for an exchange. Returns titles."""
    import urllib.parse
    query = f'repo:{TARGET_REPO} is:issue label:changelog-monitor "{exchange_id}" in:title'
    encoded = urllib.parse.quote(query)
    result = github_api("GET", f"/search/issues?q={encoded}&per_page=30")
    if result and "items" in result:
        return [item["title"] for item in result["items"]]
    return []


def create_github_issue(title: str, body: str, labels: list[str]) -> str | None:
    """Create a GitHub issue. Ensures labels exist first. Returns issue URL or None."""
    if not GITHUB_TOKEN:
        print(f"  SKIP (no token): {title}")
        return None
    ensure_labels(labels)
    result = github_api("POST", f"/repos/{TARGET_REPO}/issues", {
        "title": title,
        "body": body,
        "labels": labels,
    })
    if result and "html_url" in result:
        return result["html_url"]
    return None


def create_review_issue(title: str, body: str = "") -> str | None:
    """Create a review/error issue with needs-review label."""
    full_body = body or "This issue was automatically created by the changelog monitor.\n\n---\n*Auto-generated by exchange-changelog-monitor*"
    return create_github_issue(title, full_body, ["changelog-monitor", "needs-review"])


# --- Commands ---

def cmd_run(args):
    """Full pipeline: fetch, diff, analyze, create issues."""
    dry_run = args.dry_run or DRY_RUN
    if dry_run:
        print("=== DRY RUN MODE ===\n")

    exchanges = load_exchanges()
    state = load_state()

    # Auto-seed: if state is empty, run seed logic first to avoid flooding issues
    if not state:
        print("State is empty — running seed to establish baseline...")
        print("(No issues will be created on first run)\n")
        _seed(exchanges)
        return

    # Detect new CCXT exchanges not in exchanges.yaml
    ccxt_list = get_ccxt_exchange_list()
    new_exchanges = [eid for eid in ccxt_list if eid not in exchanges]
    if new_exchanges:
        print(f"New exchanges detected (not in exchanges.yaml): {new_exchanges}")
        for eid in new_exchanges:
            title = f"[{eid}] New exchange detected — changelog URL needed"
            if dry_run:
                print(f"  Would create review issue: {title}")
            else:
                existing = search_github_issues(eid)
                if not any("New exchange detected" in t for t in existing):
                    url = create_review_issue(title)
                    if url:
                        print(f"  Created: {url}")

    # Separate exchanges with and without URLs
    to_fetch = {}
    no_url = []
    for eid, cfg in exchanges.items():
        urls = get_exchange_urls(cfg)
        if urls:
            to_fetch[eid] = cfg
        else:
            no_url.append(eid)

    if no_url:
        print(f"\nExchanges without changelog URLs ({len(no_url)}): {no_url}")

    if not to_fetch:
        print("No exchanges with changelog URLs to check.")
        return

    print(f"\nFetching changelogs for {len(to_fetch)} exchanges...")
    fetch_results = fetch_all_changelogs(to_fetch)

    issues_created = 0
    sources_changed = 0

    for exchange_id, config in to_fetch.items():
        source_results = fetch_results.get(exchange_id, {})
        name = config.get("name", exchange_id)
        urls = get_exchange_urls(config)

        for i, source in enumerate(urls):
            label = source.get("label", f"source_{i}")
            url = source.get("url", "")
            source_key = f"{i}_{label}"
            state_key = f"{exchange_id}::{source_key}"

            result = source_results.get(source_key)
            if not result:
                continue

            # Handle fetch errors
            if result.error:
                print(f"  [{exchange_id}/{label}] Fetch failed: {result.error}")
                if not dry_run:
                    title = f"[{name}] Changelog fetch failed ({label})"
                    existing = search_github_issues(exchange_id)
                    if not any("fetch failed" in t.lower() for t in existing):
                        create_review_issue(title, f"Error: {result.error}\n\nURL: {url}\nSource: {label}")
                continue

            # Hash comparison
            new_hash = sha256(result.content)
            old_state = state.get(state_key, {})

            if new_hash == old_state.get("content_hash"):
                continue  # No changes

            sources_changed += 1
            print(f"\n  [{exchange_id}/{label}] Content changed!")

            # Agent analyzes the diff
            old_text = old_state.get("text_snapshot", "")
            existing_titles = search_github_issues(exchange_id) if not dry_run else []

            issues = analyze_changelog_diff(
                exchange_id, f"{name} ({label})", old_text, result.content, existing_titles
            )

            for issue in issues:
                title = issue.get("title", "Untitled")
                body = issue.get("body", "")
                labels = issue.get("labels", ["changelog-monitor", exchange_id])
                full_title = f"[{name}] {title}"

                if dry_run:
                    print(f"    Would create: {full_title}")
                    print(f"    Labels: {labels}")
                    print(f"    Breaking: {issue.get('breaking', False)}")
                else:
                    issue_url = create_github_issue(full_title, body, labels)
                    if issue_url:
                        print(f"    Created: {issue_url}")
                        issues_created += 1

            # Update state for this specific source
            state[state_key] = make_state_entry(new_hash, result.content)

    save_state(state)
    print(f"\n=== Done: {sources_changed} sources changed, {issues_created} issues created ===")


def _seed(exchanges: dict):
    """Internal seed logic — fetch all, save state, no issues."""
    to_fetch = {eid: cfg for eid, cfg in exchanges.items() if get_exchange_urls(cfg)}

    print(f"Seeding state for {len(to_fetch)} exchanges...")
    fetch_results = fetch_all_changelogs(to_fetch)

    state = load_state()
    seeded = 0

    for exchange_id, source_results in fetch_results.items():
        for source_key, result in source_results.items():
            state_key = f"{exchange_id}::{source_key}"
            if result.error:
                print(f"  [{exchange_id}/{source_key}] Failed: {result.error}")
                continue
            state[state_key] = make_state_entry(sha256(result.content), result.content)
            seeded += 1
            print(f"  [{exchange_id}/{source_key}] Seeded ({len(result.content)} chars)")

    save_state(state)
    print(f"\nSeeded {seeded} sources.")


def cmd_seed(args):
    """Save baseline state for all exchanges (no issues created)."""
    _seed(load_exchanges())


def cmd_check(args):
    """Test a single exchange: fetch and analyze (no state, no issues)."""
    exchange_id = args.exchange
    exchanges = load_exchanges()

    if exchange_id not in exchanges:
        print(f"Exchange '{exchange_id}' not found in exchanges.yaml")
        sys.exit(1)

    config = exchanges[exchange_id]
    urls = get_exchange_urls(config)
    name = config.get("name", exchange_id)

    if not urls:
        print(f"No changelog URLs configured for {exchange_id}")
        sys.exit(1)

    # Fetch all URLs for this exchange with a single shared browser
    print(f"Fetching {len(urls)} source(s) for {name}...")
    results = fetch_exchange_urls(urls)

    for i, source in enumerate(urls):
        label = source.get("label", f"source_{i}")
        source_key = f"{i}_{label}"
        url = source.get("url", "")

        print(f"\n--- {name} / {label} ---")
        print(f"  URL: {url}")

        result = results.get(source_key)
        if not result or result.error:
            print(f"  FAILED: {result.error if result else 'No result'}")
            continue

        print(f"  Fetched {len(result.content)} chars")
        print(f"  First 500 chars:\n{result.content[:500]}\n")

        print(f"  Analyzing with Claude Haiku...")
        issues = analyze_changelog_diff(exchange_id, f"{name} ({label})", "", result.content, [])
        if issues:
            print(f"  Found {len(issues)} potential issues:")
            for issue in issues:
                print(f"    - {issue.get('title', 'Untitled')}")
                print(f"      Breaking: {issue.get('breaking', False)}")
        else:
            print("  No issues found (or agent not available)")


# --- CLI ---

def main():
    parser = argparse.ArgumentParser(description="Exchange Changelog Monitor")
    subparsers = parser.add_subparsers(dest="command", help="Command to run")

    run_parser = subparsers.add_parser("run", help="Full pipeline")
    run_parser.add_argument("--dry-run", action="store_true", help="Log only, no issues")

    subparsers.add_parser("seed", help="Save baseline state")

    check_parser = subparsers.add_parser("check", help="Test single exchange")
    check_parser.add_argument("exchange", help="Exchange ID from exchanges.yaml")

    args = parser.parse_args()

    if args.command == "run":
        cmd_run(args)
    elif args.command == "seed":
        cmd_seed(args)
    elif args.command == "check":
        cmd_check(args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
