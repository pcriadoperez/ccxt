"""Playwright-based changelog fetching for all exchanges."""

import asyncio
from dataclasses import dataclass

from playwright.async_api import async_playwright


@dataclass
class FetchResult:
    content: str | None
    error: str | None


# Max concurrent page fetches to avoid overwhelming the browser
MAX_CONCURRENCY = 5
DEFAULT_TIMEOUT_MS = 30000


async def _fetch_one(browser, url: str, timeout_ms: int) -> FetchResult:
    """Fetch a single URL in a new page. Returns FetchResult (never raises)."""
    try:
        page = await browser.new_page()
        try:
            await page.goto(url, timeout=timeout_ms, wait_until="domcontentloaded")
            # Give JS a moment to render dynamic content
            await page.wait_for_timeout(2000)
            content = await page.inner_text("body")
            if not content or not content.strip():
                return FetchResult(content=None, error="Empty page content")
            return FetchResult(content=content.strip(), error=None)
        finally:
            await page.close()
    except Exception as e:
        return FetchResult(content=None, error=str(e))


async def _fetch_all_async(
    jobs: list[tuple[str, str, str]], timeout_ms: int
) -> dict[str, FetchResult]:
    """Fetch all jobs concurrently with a semaphore.

    Args:
        jobs: list of (key, url, exchange_id) tuples
        timeout_ms: timeout per page

    Returns:
        dict of {key: FetchResult}
    """
    results = {}
    sem = asyncio.Semaphore(MAX_CONCURRENCY)

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)

        async def fetch_with_sem(key, url):
            async with sem:
                results[key] = await _fetch_one(browser, url, timeout_ms)

        tasks = [fetch_with_sem(key, url) for key, url, _ in jobs]
        await asyncio.gather(*tasks)
        await browser.close()

    return results


def fetch_changelog(url: str, timeout_ms: int = DEFAULT_TIMEOUT_MS) -> FetchResult:
    """Fetch a single changelog URL. Convenience wrapper around async internals."""
    return asyncio.run(_fetch_single_async(url, timeout_ms))


async def _fetch_single_async(url: str, timeout_ms: int) -> FetchResult:
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        result = await _fetch_one(browser, url, timeout_ms)
        await browser.close()
        return result


def fetch_all_changelogs(
    exchanges: dict, timeout_ms: int = DEFAULT_TIMEOUT_MS
) -> dict[str, dict[str, FetchResult]]:
    """Fetch changelogs for all exchanges concurrently.

    Args:
        exchanges: dict from exchanges.yaml {exchange_id: {name, changelog_urls: [...]}}
        timeout_ms: timeout per page in milliseconds

    Returns:
        dict of {exchange_id: {source_key: FetchResult}}
    """
    # Build flat job list
    jobs = []  # (key_path, url, exchange_id)
    exchange_keys = {}  # exchange_id -> list of source_keys

    for exchange_id, config in exchanges.items():
        urls = config.get("changelog_urls", [])
        if not urls:
            exchange_keys[exchange_id] = ["0_default"]
            continue
        source_keys = []
        for i, source in enumerate(urls):
            url = source.get("url", "")
            label = source.get("label", f"source_{i}")
            source_key = f"{i}_{label}"
            source_keys.append(source_key)
            if url:
                jobs.append((f"{exchange_id}::{source_key}", url, exchange_id))
        exchange_keys[exchange_id] = source_keys

    # Run all fetches concurrently
    if jobs:
        flat_results = asyncio.run(_fetch_all_async(jobs, timeout_ms))
    else:
        flat_results = {}

    # Reassemble into nested structure
    results = {}
    for exchange_id, config in exchanges.items():
        urls = config.get("changelog_urls", [])
        exchange_results = {}
        if not urls:
            exchange_results["0_default"] = FetchResult(
                content=None, error="No changelog URLs configured"
            )
        else:
            for i, source in enumerate(urls):
                url = source.get("url", "")
                label = source.get("label", f"source_{i}")
                source_key = f"{i}_{label}"
                flat_key = f"{exchange_id}::{source_key}"
                if not url:
                    exchange_results[source_key] = FetchResult(
                        content=None, error="Empty URL"
                    )
                elif flat_key in flat_results:
                    exchange_results[source_key] = flat_results[flat_key]
                else:
                    exchange_results[source_key] = FetchResult(
                        content=None, error="Fetch not attempted"
                    )
        results[exchange_id] = exchange_results

    return results


def fetch_exchange_urls(
    urls: list[dict], timeout_ms: int = DEFAULT_TIMEOUT_MS
) -> dict[str, FetchResult]:
    """Fetch multiple URLs for a single exchange, reusing one browser.

    Used by the `check` command.

    Args:
        urls: list of {label, url} dicts
        timeout_ms: timeout per page

    Returns:
        dict of {source_key: FetchResult}
    """
    jobs = []
    for i, source in enumerate(urls):
        url = source.get("url", "")
        label = source.get("label", f"source_{i}")
        source_key = f"{i}_{label}"
        if url:
            jobs.append((source_key, url, ""))

    if not jobs:
        return {}

    flat_results = asyncio.run(_fetch_all_async(jobs, timeout_ms))

    results = {}
    for i, source in enumerate(urls):
        url = source.get("url", "")
        label = source.get("label", f"source_{i}")
        source_key = f"{i}_{label}"
        if not url:
            results[source_key] = FetchResult(content=None, error="Empty URL")
        elif source_key in flat_results:
            results[source_key] = flat_results[source_key]
    return results
