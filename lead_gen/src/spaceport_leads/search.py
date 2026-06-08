from __future__ import annotations

import base64
from dataclasses import dataclass
from urllib.parse import parse_qs, urlparse

import requests
from bs4 import BeautifulSoup


@dataclass(frozen=True)
class SearchResult:
    title: str
    url: str
    snippet: str
    query: str


def clean_duckduckgo_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.netloc.endswith("duckduckgo.com") and parsed.path == "/l/":
        uddg = parse_qs(parsed.query).get("uddg")
        if uddg:
            return uddg[0]
    return url


def clean_bing_url(url: str) -> str:
    parsed = urlparse(url)
    if not parsed.netloc.endswith("bing.com"):
        return url

    encoded = parse_qs(parsed.query).get("u")
    if not encoded:
        return url

    value = encoded[0]
    if value.startswith("a1"):
        value = value[2:]
    padding = "=" * (-len(value) % 4)
    try:
        return base64.urlsafe_b64decode(value + padding).decode("utf-8")
    except Exception:
        return url


def duckduckgo_search(query: str, *, limit: int, user_agent: str) -> list[SearchResult]:
    response = requests.get(
        "https://duckduckgo.com/html/",
        params={"q": query},
        headers={"User-Agent": user_agent},
        timeout=20,
    )
    response.raise_for_status()
    soup = BeautifulSoup(response.text, "html.parser")

    results: list[SearchResult] = []
    for result in soup.select(".result"):
        title_el = result.select_one(".result__a")
        if title_el is None:
            continue
        snippet_el = result.select_one(".result__snippet")
        results.append(
            SearchResult(
                title=title_el.get_text(" ", strip=True),
                url=clean_duckduckgo_url(title_el.get("href", "")),
                snippet=snippet_el.get_text(" ", strip=True) if snippet_el else "",
                query=query,
            )
        )
        if len(results) >= limit:
            break
    return results


def bing_search(query: str, *, limit: int, user_agent: str) -> list[SearchResult]:
    response = requests.get(
        "https://www.bing.com/search",
        params={"q": query},
        headers={"User-Agent": user_agent},
        timeout=20,
    )
    response.raise_for_status()
    soup = BeautifulSoup(response.text, "html.parser")

    results: list[SearchResult] = []
    for result in soup.select("li.b_algo"):
        title_el = result.select_one("h2 a")
        if title_el is None:
            continue
        snippet_el = result.select_one(".b_caption p")
        results.append(
            SearchResult(
                title=title_el.get_text(" ", strip=True),
                url=clean_bing_url(title_el.get("href", "")),
                snippet=snippet_el.get_text(" ", strip=True) if snippet_el else "",
                query=query,
            )
        )
        if len(results) >= limit:
            break
    return results


def web_search(query: str, *, limit: int, user_agent: str) -> list[SearchResult]:
    results = duckduckgo_search(query, limit=limit, user_agent=user_agent)
    if results:
        return results
    return bing_search(query, limit=limit, user_agent=user_agent)
