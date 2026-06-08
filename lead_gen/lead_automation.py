import argparse
import json
import os
from dataclasses import dataclass
from typing import Dict, List, Set, Tuple

import gspread
import requests
from requests import RequestException
from bs4 import BeautifulSoup
from google.oauth2.service_account import Credentials
from rapidfuzz import fuzz

SHEET_IN_PERSON_CANDIDATES = ["In Person", "In-Person", "InPerson"]
SHEET_COLD_CALL_CANDIDATES = ["Cold Call", "Cold Calls", "Cold-Call"]

COLD_CALL_TARGET = 400
MAX_CANDIDATES_PER_QUERY = 30

IN_PERSON_GEOS = [
    "Provo UT civil engineering",
    "Orem UT structural engineering",
    "Lehi UT land development engineering",
    "American Fork UT civil engineering",
    "Draper UT civil engineering",
    "Sandy UT structural engineering",
    "Salt Lake City UT land development engineering",
    "Spanish Fork UT civil engineering",
    "Payson UT structural engineering",
]

COLD_CALL_GEOS = [
    "Boise ID civil engineering land development",
    "Meridian ID structural engineering",
    "Phoenix AZ civil engineering site development",
    "Mesa AZ land development engineering",
    "Dallas TX civil engineering subdivision",
    "Austin TX structural engineering commercial",
    "San Antonio TX civil engineering grading",
    "Houston TX land development engineering",
    "Salt Lake City UT civil engineering",
    "Ogden UT structural engineering",
]

INCLUDE_KEYWORDS = {
    "civil engineering",
    "structural engineering",
    "land development",
    "site development",
    "grading plan",
    "drainage",
    "stormwater",
    "construction documents",
    "plan set",
    "autocad",
    "civil 3d",
    "cad",
    "drafting",
    "revisions",
    "subdivision",
    "entitlement",
    "bim",
}

EXCLUDE_KEYWORDS = {
    "electrical only",
    "plumbing only",
    "surveying only",
    "land survey only",
    "geotechnical only",
    "mep only",
    "hvac only",
    "interior design only",
}

SEARCH_HEADERS = {"User-Agent": "Mozilla/5.0"}


@dataclass
class Firm:
    name: str
    location: str
    website: str
    phone: str
    source_query: str
    score: int
    rationale: str


def get_client():
    creds_json = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    creds_path = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON_PATH")
    scopes = ["https://www.googleapis.com/auth/spreadsheets"]

    if creds_json:
        creds = Credentials.from_service_account_info(json.loads(creds_json), scopes=scopes)
    elif creds_path:
        creds = Credentials.from_service_account_file(creds_path, scopes=scopes)
    else:
        raise ValueError(
            "Set GOOGLE_SERVICE_ACCOUNT_JSON (JSON string) or GOOGLE_SERVICE_ACCOUNT_JSON_PATH (file path)."
        )

    return gspread.authorize(creds)


def get_sheet(gc):
    sheet_id = os.environ["LEAD_SHEET_ID"]
    return gc.open_by_key(sheet_id)




def get_or_create_worksheet(sh, candidate_titles: List[str], rows: int = 1000, cols: int = 12):
    existing = {ws.title: ws for ws in sh.worksheets()}
    for title in candidate_titles:
        if title in existing:
            return existing[title]
    return sh.add_worksheet(title=candidate_titles[0], rows=rows, cols=cols)
def ensure_headers(ws, headers: List[str]):
    row = ws.row_values(1)
    if row != headers:
        ws.clear()
        ws.append_row(headers)


def normalize_name(name: str) -> str:
    return " ".join(name.lower().replace("llc", "").replace("inc", "").replace(",", " ").split())


def duckduckgo_candidates(query: str, limit: int = 20) -> List[Dict[str, str]]:
    url = "https://duckduckgo.com/html/"
    try:
        resp = requests.get(url, params={"q": query}, headers=SEARCH_HEADERS, timeout=20)
        resp.raise_for_status()
    except RequestException as exc:
        print(f"Search request failed for query={query!r}: {exc}")
        return []
    soup = BeautifulSoup(resp.text, "html.parser")
    out = []
    for r in soup.select(".result")[:limit]:
        title = r.select_one(".result__a")
        snippet = r.select_one(".result__snippet")
        if not title:
            continue
        out.append(
            {
                "title": title.get_text(" ", strip=True),
                "href": title.get("href", ""),
                "snippet": snippet.get_text(" ", strip=True) if snippet else "",
            }
        )
    return out


def fetch_page_text(url: str) -> str:
    if not url.startswith("http"):
        return ""
    try:
        r = requests.get(url, headers=SEARCH_HEADERS, timeout=15)
        if r.status_code >= 400:
            return ""
        return BeautifulSoup(r.text, "html.parser").get_text(" ", strip=True).lower()[:50000]
    except Exception:
        return ""


def icp_score(text: str, snippet: str, title: str) -> Tuple[int, str]:
    corpus = f"{title} {snippet} {text}".lower()
    include_hits = sum(1 for k in INCLUDE_KEYWORDS if k in corpus)
    exclude_hits = sum(1 for k in EXCLUDE_KEYWORDS if k in corpus)

    score = min(100, include_hits * 10) - exclude_hits * 25
    score = max(0, score)

    rationale = f"include_hits={include_hits}; exclude_hits={exclude_hits}"
    return score, rationale


def parse_candidate(candidate: Dict[str, str], query: str) -> Firm | None:
    page_text = fetch_page_text(candidate["href"])
    score, rationale = icp_score(page_text, candidate.get("snippet", ""), candidate.get("title", ""))
    if score < 40:
        return None

    return Firm(
        name=candidate["title"].split("|")[0].strip(),
        location="",
        website=candidate["href"],
        phone="",
        source_query=query,
        score=score,
        rationale=rationale,
    )


def existing_names(ws) -> Set[str]:
    values = ws.get_all_values()
    if len(values) <= 1:
        return set()
    return {normalize_name(row[0]) for row in values[1:] if row}


def add_firms(ws, firms: List[Firm], seen: Set[str]) -> int:
    added = 0
    for firm in firms:
        normalized = normalize_name(firm.name)
        if normalized in seen:
            continue
        seen.add(normalized)
        ws.append_row([firm.name, firm.location, firm.website, firm.phone, firm.source_query, firm.score, firm.rationale])
        added += 1
    return added


def fuzzy_dedupe(ws):
    rows = ws.get_all_values()
    if len(rows) <= 2:
        return

    headers, data = rows[0], rows[1:]
    kept = []

    for row in data:
        name = normalize_name(row[0]) if row else ""
        if not name:
            continue

        duplicate = False
        for k in kept:
            if fuzz.ratio(name, normalize_name(k[0])) >= 94:
                duplicate = True
                break

        if not duplicate:
            kept.append(row)

    ws.clear()
    ws.append_row(headers)
    for row in kept:
        ws.append_row(row)


def collect_validated_firms(queries: List[str], target_count: int, seen: Set[str]) -> List[Firm]:
    validated: List[Firm] = []
    checked = 0

    for query in queries:
        for candidate in duckduckgo_candidates(query, limit=MAX_CANDIDATES_PER_QUERY):
            checked += 1
            firm = parse_candidate(candidate, query)
            if not firm:
                continue

            if normalize_name(firm.name) in seen:
                continue

            validated.append(firm)
            seen.add(normalize_name(firm.name))
            if len(validated) >= target_count:
                return validated

    print(f"Checked {checked} candidates; validated {len(validated)}.")
    return validated


def fill_in_person(ws, target_count: int = 15):
    seen = existing_names(ws)
    firms = collect_validated_firms(IN_PERSON_GEOS, target_count, seen)
    add_firms(ws, firms, existing_names(ws))
    fuzzy_dedupe(ws)


def cold_call_count(ws) -> int:
    return max(0, len(ws.get_all_values()) - 1)


def cold_call_batch(ws, batch_size: int):
    seen = existing_names(ws)
    firms = collect_validated_firms(COLD_CALL_GEOS, batch_size, seen)
    added = add_firms(ws, firms, existing_names(ws))
    fuzzy_dedupe(ws)
    print(f"Added {added}/{batch_size} firms this run.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--batch-size", type=int, default=5)
    parser.add_argument("--target-cold", type=int, default=COLD_CALL_TARGET)
    parser.add_argument("--fill-in-person", action="store_true", help="Ensure in-person sheet has qualified firms.")
    args = parser.parse_args()

    gc = get_client()
    sh = get_sheet(gc)

    ws_in = get_or_create_worksheet(sh, SHEET_IN_PERSON_CANDIDATES)
    ws_cold = get_or_create_worksheet(sh, SHEET_COLD_CALL_CANDIDATES)

    headers = ["Firm", "Location", "Website", "Phone", "Source Query", "ICP Score", "Rationale"]
    ensure_headers(ws_in, headers)
    ensure_headers(ws_cold, headers)

    if args.fill_in_person and cold_call_count(ws_in) < 15:
        fill_in_person(ws_in, 15)

    if cold_call_count(ws_cold) < args.target_cold:
        cold_call_batch(ws_cold, args.batch_size)
    else:
        print("Cold call target already reached.")


if __name__ == "__main__":
    main()
