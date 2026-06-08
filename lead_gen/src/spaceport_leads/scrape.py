from __future__ import annotations

from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup


def same_site_url(base_url: str, path: str) -> str:
    if not path:
        return base_url
    return urljoin(base_url.rstrip("/") + "/", path.strip("/"))


def is_likely_company_site(url: str) -> bool:
    host = urlparse(url).netloc.lower()
    blocked = (
        "linkedin.com",
        "facebook.com",
        "instagram.com",
        "youtube.com",
        "wikipedia.org",
        "yelp.com",
        "bbb.org",
        "indeed.com",
        "glassdoor.com",
        "zoominfo.com",
    )
    return bool(host) and not any(domain in host for domain in blocked)


def fetch_text(url: str, *, user_agent: str, timeout: float = 5.0) -> str:
    try:
        response = requests.get(url, headers={"User-Agent": user_agent}, timeout=timeout)
        if response.status_code >= 400 or "text/html" not in response.headers.get("Content-Type", ""):
            return ""
    except requests.RequestException:
        return ""

    soup = BeautifulSoup(response.text, "html.parser")
    for tag in soup(["script", "style", "noscript", "svg"]):
        tag.extract()
    return soup.get_text(" ", strip=True)


def scrape_company_pages(base_url: str, paths: list[str], *, user_agent: str) -> dict[str, str]:
    pages: dict[str, str] = {}
    for path in paths:
        url = same_site_url(base_url, path)
        text = fetch_text(url, user_agent=user_agent)
        if text:
            pages[url] = text[:50000]
    return pages
