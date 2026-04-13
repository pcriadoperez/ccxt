"""Playwright-based changelog fetching for all exchanges."""

from dataclasses import dataclass
from playwright.sync_api import sync_playwright


@dataclass
class FetchResult:
    content: str | None
    error: str | None


def fetch_changelog(url: str, timeout_ms: int = 30000) -> FetchResult:
    """Fetch a single changelog URL using Playwright headless Chromium.

    Returns FetchResult with content or error (never raises).
    """
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.goto(url, timeout=timeout_ms, wait_until="networkidle")
            content = page.inner_text("body")
            browser.close()
            if not content or not content.strip():
                return FetchResult(content=None, error="Empty page content")
            return FetchResult(content=content.strip(), error=None)
    except Exception as e:
        return FetchResult(content=None, error=str(e))


def fetch_all_changelogs(exchanges: dict, timeout_ms: int = 30000) -> dict[str, dict[str, FetchResult]]:
    """Fetch changelogs for all exchanges using a single browser instance.

    Args:
        exchanges: dict from exchanges.yaml {exchange_id: {name, changelog_urls: [{label, url}]}}
        timeout_ms: timeout per page in milliseconds

    Returns:
        dict of {exchange_id: {source_key: FetchResult}}
        where source_key is "{index}_{label}" for each URL in changelog_urls
    """
    results = {}
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            for exchange_id, config in exchanges.items():
                urls = config.get("changelog_urls", [])
                if not urls:
                    results[exchange_id] = {
                        "0_default": FetchResult(content=None, error="No changelog URLs configured")
                    }
                    continue
                exchange_results = {}
                for i, source in enumerate(urls):
                    url = source.get("url", "")
                    label = source.get("label", f"source_{i}")
                    source_key = f"{i}_{label}"
                    if not url:
                        exchange_results[source_key] = FetchResult(
                            content=None, error="Empty URL"
                        )
                        continue
                    try:
                        page = browser.new_page()
                        page.goto(url, timeout=timeout_ms, wait_until="networkidle")
                        content = page.inner_text("body")
                        page.close()
                        if not content or not content.strip():
                            exchange_results[source_key] = FetchResult(
                                content=None, error="Empty page content"
                            )
                        else:
                            exchange_results[source_key] = FetchResult(
                                content=content.strip(), error=None
                            )
                    except Exception as e:
                        exchange_results[source_key] = FetchResult(content=None, error=str(e))
                results[exchange_id] = exchange_results
            browser.close()
    except Exception as e:
        for exchange_id in exchanges:
            if exchange_id not in results:
                results[exchange_id] = {
                    "0_default": FetchResult(content=None, error=f"Browser launch failed: {e}")
                }
    return results
