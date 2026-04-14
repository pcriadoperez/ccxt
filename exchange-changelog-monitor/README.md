# Exchange Changelog Monitor

Automated daily monitoring of API changelogs for all cryptocurrency exchanges supported by CCXT. When an exchange publishes API changes (new endpoints, deprecations, breaking changes), this tool detects the update and creates a GitHub issue.

## Architecture

1. **Playwright** (async, concurrent) fetches each exchange's changelog pages — handles JS-rendered pages and bot blocking
2. **SHA-256 hashing** detects content changes since the last run
3. **Claude Haiku** interprets the diff and extracts structured API change data
4. **GitHub API** creates issues with auto-created labels, deduplicating against existing ones
5. **state.json** (committed to repo) tracks what was seen last

Each exchange can have **multiple changelog sources** (spot API, futures API, announcements, etc.), all monitored independently.

## Usage

```bash
# Install
pip install -r requirements.txt
playwright install chromium

# Test a single exchange (fetches all its sources)
python monitor.py check binance

# Save baseline state (first run — no issues created)
python monitor.py seed

# Full run (dry mode)
python monitor.py run --dry-run

# Full run (creates issues)
export GITHUB_TOKEN=ghp_...
export ANTHROPIC_API_KEY=sk-...
export TARGET_REPO=owner/repo
python monitor.py run
```

Note: if state.json is empty, `run` will automatically seed first to avoid creating issues for the entire changelog history.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for Claude Haiku |
| `GITHUB_TOKEN` | Yes | GitHub token with issues:write scope |
| `TARGET_REPO` | No | Target repo for issues (default: `pcriadoperez/ccxt`) |
| `DRY_RUN` | No | Set to `"true"` to skip issue creation |

## Adding Exchanges

Edit `exchanges.yaml`. Each exchange supports multiple changelog sources:

```yaml
newexchange:
  name: New Exchange
  changelog_urls:
    - label: spot-api
      url: "https://docs.newexchange.com/spot/changelog"
    - label: futures-api
      url: "https://docs.newexchange.com/futures/changelog"
    - label: announcements
      url: "https://newexchange.com/announcements/api"
```

Exchanges with empty `changelog_urls: []` will trigger a "needs review" issue.

## Auto-detection

The monitor compares `exchanges.yaml` against the live CCXT exchange list (from `python/ccxt/__init__.py`). New exchanges added to CCXT that aren't in the YAML automatically get a "new exchange detected" review issue.

## GitHub Actions

The workflow runs daily at 08:00 UTC via `.github/workflows/changelog-monitor.yml`. It can also be triggered manually with a dry-run option. Labels are auto-created in the target repo.
