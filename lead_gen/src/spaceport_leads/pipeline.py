from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass
from urllib.parse import urlparse

from . import db
from .scrape import is_likely_company_site, scrape_company_pages
from .scoring import classify_and_score
from .search import SearchResult, web_search


@dataclass(frozen=True)
class PipelineResult:
    name: str
    url: str
    score: int
    decision: str
    reasoning: str


def firm_name_from_title(title: str) -> str:
    name = re.split(r"\s[-|•]\s", title, maxsplit=1)[0].strip()
    return re.sub(r"\s+", " ", name)[:160]


def has_research_signal(result: SearchResult) -> bool:
    if result.query == "seed_candidate":
        return True
    text = f"{result.title} {result.snippet}".lower()
    signals = (
        "civil",
        "engineering",
        "land development",
        "site development",
        "grading",
        "drainage",
        "stormwater",
        "utility",
        "subdivision",
    )
    return any(signal in text for signal in signals)


def discover(geo: str, config: dict, *, user_agent: str, search_depth: int) -> list[SearchResult]:
    seed_candidates = config["market"].get("seed_candidates", {}).get(geo, [])
    results = [
        SearchResult(
            title=seed["name"],
            url=seed["url"],
            snippet=seed.get("snippet", ""),
            query="seed_candidate",
        )
        for seed in seed_candidates
    ]
    seen_urls: set[str] = {result.url.rstrip("/") for result in results}

    queries = [
        query.format(geo=geo)
        for query in config["agents"]["research"]["search_queries"]
    ]
    per_query_limit = max(5, search_depth // max(1, len(queries)))

    for query in queries:
        for result in web_search(query, limit=per_query_limit, user_agent=user_agent):
            normalized_url = result.url.rstrip("/")
            if normalized_url in seen_urls or not is_likely_company_site(normalized_url):
                continue
            if not has_research_signal(result):
                continue
            seen_urls.add(normalized_url)
            results.append(result)
            if len(results) >= search_depth:
                return results
    return results


def run_pipeline(
    conn: sqlite3.Connection,
    *,
    geo: str,
    config: dict,
    user_agent: str,
    limit: int,
    search_depth: int,
) -> list[PipelineResult]:
    run_id = conn.execute(
        "INSERT INTO research_runs (geo, status, requested_limit) VALUES (?, ?, ?)",
        (geo, "running", limit),
    ).lastrowid

    paths = config["agents"]["scraping"]["preferred_paths"]
    candidates = discover(geo, config, user_agent=user_agent, search_depth=search_depth)

    for candidate in candidates:
        company_pages = scrape_company_pages(candidate.url, paths, user_agent=user_agent)
        corpus = " ".join([candidate.title, candidate.snippet, *company_pages.values()])
        score = classify_and_score(corpus, config)
        host = urlparse(candidate.url).netloc
        name = firm_name_from_title(candidate.title) or host
        firm_id = db.upsert_firm(
            conn,
            name=name,
            website_url=candidate.url,
            market=geo,
            description=candidate.snippet,
        )
        db.add_source(
            conn,
            firm_id=firm_id,
            source_type="search_result",
            url=candidate.url,
            title=candidate.title,
            snippet=candidate.snippet,
            raw_text=corpus[:50000],
        )
        for url, page_text in company_pages.items():
            db.add_source(
                conn,
                firm_id=firm_id,
                source_type="scraped_page",
                url=url,
                title="",
                snippet="",
                raw_text=page_text,
            )
        db.add_score(conn, firm_id, score)
        conn.execute(
            "INSERT OR IGNORE INTO research_run_firms (research_run_id, firm_id) VALUES (?, ?)",
            (run_id, firm_id),
        )
        conn.commit()

    ranked = db.ranked_firms(conn, limit)
    for index, row in enumerate(ranked, start=1):
        firm_id_row = conn.execute(
            "SELECT id FROM firms WHERE name = ? AND website_url = ?",
            (row["name"], row["website_url"]),
        ).fetchone()
        if firm_id_row:
            conn.execute(
                """
                UPDATE research_run_firms
                SET rank = ?
                WHERE research_run_id = ? AND firm_id = ?
                """,
                (index, run_id, firm_id_row["id"]),
            )

    conn.execute(
        "UPDATE research_runs SET status = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?",
        ("completed", run_id),
    )
    conn.commit()

    return [
        PipelineResult(
            name=row["name"],
            url=row["website_url"],
            score=row["total_score"],
            decision=row["decision"],
            reasoning=row["reasoning"],
        )
        for row in ranked
    ]
