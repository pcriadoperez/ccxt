"""Claude Haiku agent for interpreting changelog diffs and producing issue data."""

import json
import os

import anthropic


MODEL = "claude-haiku-4-5-20251001"
MAX_INPUT_CHARS = 12000  # keep input tokens reasonable


SYSTEM_PROMPT = """You are analyzing a changelog diff for a cryptocurrency exchange API.
You will receive the exchange name, the OLD text snapshot, and the NEW text snapshot of their API changelog page.

Your job:
1. Compare old vs new and identify genuinely NEW API changes (new endpoints, parameter changes, deprecations, breaking changes, rate limit changes, new features, bug fixes).
2. Ignore: typo fixes, documentation rewording, cosmetic/layout changes, SDK-only changes, marketing text.
3. For each real API change, produce a structured JSON object.

Output a JSON array (no markdown fences). Each element:
{
  "title": "Short descriptive title of the change",
  "body": "Markdown issue body with: date (if visible), summary of what changed, affected endpoints/parameters, whether this is breaking, and what CCXT might need to update",
  "labels": ["changelog-monitor", "<exchange_id>"],
  "breaking": false
}

If the change is breaking, add "breaking" to the labels array and set breaking: true.

If there are no real API changes (only cosmetic/layout diffs), return an empty array: []

Important:
- Be concise — titles under 80 chars, body under 500 chars
- Focus on what matters for a trading library maintainer
- Include the date of the change if visible in the text
- If the old text is empty (first run), extract only the MOST RECENT changes (last 2-3 entries), not the entire history"""


def analyze_changelog_diff(
    exchange_id: str,
    exchange_name: str,
    old_text: str,
    new_text: str,
    existing_issue_titles: list[str],
) -> list[dict]:
    """Send changelog diff to Claude Haiku and get structured issue data.

    Returns list of issue dicts with title, body, labels, breaking fields.
    Returns empty list on any error.
    """
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("  WARNING: ANTHROPIC_API_KEY not set, skipping agent analysis")
        return []

    # Truncate to keep costs low
    old_truncated = old_text[-MAX_INPUT_CHARS:] if len(old_text) > MAX_INPUT_CHARS else old_text
    new_truncated = new_text[:MAX_INPUT_CHARS]

    # Build dedup context
    dedup_text = ""
    if existing_issue_titles:
        dedup_text = "\n\nAlready existing issues (DO NOT create duplicates of these):\n"
        dedup_text += "\n".join(f"- {t}" for t in existing_issue_titles[:20])

    user_message = f"""Exchange: {exchange_name} (ID: {exchange_id})
{dedup_text}

=== OLD CHANGELOG SNAPSHOT ===
{old_truncated if old_truncated else "(empty — first run)"}

=== NEW CHANGELOG SNAPSHOT ===
{new_truncated}"""

    try:
        client = anthropic.Anthropic(api_key=api_key)
        response = client.messages.create(
            model=MODEL,
            max_tokens=2000,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_message}],
        )
        raw = response.content[0].text.strip()
        # Strip markdown fences if present
        if raw.startswith("```"):
            lines = raw.split("\n")
            raw = "\n".join(lines[1:])
        if raw.endswith("```"):
            raw = raw[:-3]
        raw = raw.strip()

        # Try parsing the full response first
        try:
            issues = json.loads(raw)
        except json.JSONDecodeError:
            # Try to find and parse just the JSON array portion
            start = raw.find("[")
            end = raw.rfind("]")
            if start != -1 and end != -1:
                try:
                    issues = json.loads(raw[start:end + 1])
                except json.JSONDecodeError as e:
                    print(f"  WARNING: Failed to parse agent JSON response: {e}")
                    return []
            else:
                print(f"  WARNING: No JSON array found in agent response")
                return []

        if not isinstance(issues, list):
            print(f"  WARNING: Agent returned non-list: {type(issues)}")
            return []
        return issues
    except Exception as e:
        print(f"  WARNING: Agent call failed: {e}")
        return []
