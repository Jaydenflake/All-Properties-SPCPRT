from playwright.sync_api import sync_playwright, TimeoutError as PWTimeoutError
from supabase import create_client
import os
import re
import time
from urllib.parse import urljoin

# Interactive scraping: visible Chromium by default so you can complete Cloudflare manually.
# Unattended/CI only: set PLAYWRIGHT_HEADLESS=1 (Cloudflare may still block automated browsers).
_HEADLESS_RAW = os.environ.get("PLAYWRIGHT_HEADLESS", "0").strip().lower()
HEADLESS = _HEADLESS_RAW in ("1", "true", "yes", "y", "on")
USER_DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".pw-profile")

# =========================
# 🔐 HARDCODED SUPABASE CONFIG (REPLACE THESE)
# =========================
SUPABASE_URL = "https://rqomxflhuxnivwkdrwbv.supabase.co"
SUPABASE_SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJxb214ZmxodXhuaXZ3a2R3cmJ2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NzU1ODgyMiwiZXhwIjoyMDkzMTM0ODIyfQ.nkp1CKQM_oGH4niEuyi5OrEG7x9Lm7-S-QzAQxPvXCQ"

supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

BASE_URL = "https://canyonvista-apts.securecafe.com/onlineleasing/canyon-vista2/floorplans"
PROPERTY_NAME = "Canyon Vista Apartments"


# =========================
# HELPERS
# =========================
def extract_price(text):
    if not text:
        return None
    match = re.search(r"\$([\d,]+)", text)
    return int(match.group(1).replace(",", "")) if match else None


def extract_number(text):
    if not text:
        return None
    match = re.search(r"\d+", text)
    return int(match.group()) if match else None


def _is_cloudflare(page):
    try:
        title = (page.title() or "").lower()
        if "just a moment" in title or "attention required" in title:
            return True
    except Exception:
        pass
    try:
        if page.locator("body").count() == 0:
            return False
        body = page.locator("body").inner_text(timeout=500)
    except Exception:
        return False
    text = (body or "").lower()
    return (
        "performing security verification" in text
        or "verifying you are human" in text
        or "verify you are human" in text
        or "checking your browser" in text
    )


def wait_past_cloudflare(page, target_selector: str, timeout_ms: int = 180_000):
    """Block until target_selector is visible. If Cloudflare is showing, prompt user to click through."""
    deadline = time.time() + timeout_ms / 1000
    notified = False
    while time.time() < deadline:
        try:
            page.wait_for_selector(target_selector, timeout=2000, state="visible")
            return
        except PWTimeoutError:
            pass
        except Exception as e:
            err = str(e).lower()
            if "target closed" in err or "browser has been closed" in err:
                raise RuntimeError(
                    "The Chromium window was closed before scraping finished. "
                    "Run the script again and keep that window open until the terminal prints FINAL RESULT."
                ) from e
            raise
        if _is_cloudflare(page):
            if not notified:
                print("\n[!] Cloudflare verification detected.")
                print("    -> Click the checkbox / complete it in the open browser window.")
                print("    Waiting for the real page to load...\n")
                notified = True
    raise TimeoutError(f"Timed out waiting for {target_selector}")


def goto_with_retry(page, url, attempts=4):
    """Navigate with retries; helps with transient net::ERR_EMPTY_RESPONSE / TLS hiccups."""
    last_err = None
    for attempt in range(1, attempts + 1):
        try:
            page.goto(
                url,
                wait_until="domcontentloaded",
                timeout=120_000,
            )
            return
        except Exception as e:
            last_err = e
            if attempt < attempts:
                print(f"  [!] Navigation attempt {attempt}/{attempts} failed: {e}")
                print("      Retrying in 3s...")
                time.sleep(3)
    raise last_err


# =========================
# DB FUNCTIONS
# =========================
def get_property_id():
    result = (
        supabase.table("properties")
        .select("id")
        .eq("name", PROPERTY_NAME)
        .single()
        .execute()
    )
    return result.data["id"]


def reset_all_units_unavailable(property_id):
    print("Resetting all units to unavailable...")
    supabase.table("apartment_units").update({
        "available": False
    }).eq("property_id", property_id).execute()


def upsert_floorplan(property_id, fp):
    result = (
        supabase.table("floorplans")
        .upsert({
            "property_id": property_id,
            "floorplan_name": fp["name"],
            "unit_type": fp["unit_type"],
            "starting_price": fp["starting_price"],
            "available_count": fp["available_count"],
            "features": fp["features"],
            "source_url": fp["details_url"],
            "last_scraped_at": "now()"
        }, on_conflict="property_id,floorplan_name")
        .execute()
    )

    return result.data[0]["id"] if result.data else None


def update_available_unit(property_id, floorplan_id, fp, unit):
    supabase.table("apartment_units").upsert({
        "property_id": property_id,
        "floorplan_id": floorplan_id,
        "unit_number": unit["unit_number"],
        "unit_type": fp["unit_type"],
        "floorplan_name": fp["name"],
        "rent": unit["rent"],
        "available": True,
        "apply_url": unit["apply_url"],
        "scraped_source_url": fp["details_url"],
        "last_seen_available_at": "now()",
        "last_scraped_at": "now()"
    }, on_conflict="property_id,unit_number").execute()


# =========================
# SCRAPER
# =========================
def scrape():
    data = []

    if HEADLESS:
        print(
            "\n[!] PLAYWRIGHT_HEADLESS is on — no browser window will open.\n"
            "    You cannot click through Cloudflare. For a visible window, run:\n"
            "      PowerShell:  Remove-Item Env:PLAYWRIGHT_HEADLESS -ErrorAction SilentlyContinue\n"
            "                   $env:PLAYWRIGHT_HEADLESS='0'; python CV-Scrape.py\n"
            "      cmd.exe:     set PLAYWRIGHT_HEADLESS=0 && python CV-Scrape.py\n\n"
        )
    else:
        print(
            "\n[*] Opening Chromium in a visible window.\n"
            "    Complete any Cloudflare / \"verify human\" step in that window — "
            "the script waits until the real floorplan page loads, then continues.\n"
        )

    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            USER_DATA_DIR,
            headless=HEADLESS,
            viewport={"width": 1280, "height": 900},
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
            ),
        )
        page = context.pages[0] if context.pages else context.new_page()

        goto_with_retry(page, BASE_URL)
        wait_past_cloudflare(page, ".fp-card")

        cards = page.query_selector_all(".fp-card")
        print(f"Found {len(cards)} floorplans")

        floorplans = []

        for card in cards:
            try:
                name = card.query_selector("h2").inner_text().strip()
                unit_type = card.inner_text().split("\n")[0].strip()

                price_text = card.query_selector(".fp-price").inner_text()
                price = extract_price(price_text)

                availability_text = card.query_selector(".fp-availability").inner_text()
                available_count = extract_number(availability_text)

                details_link = card.query_selector("a.btn-viewDetails").get_attribute("href")
                details_url = urljoin(BASE_URL, details_link)

                floorplans.append({
                    "name": name,
                    "unit_type": unit_type,
                    "starting_price": price,
                    "available_count": available_count,
                    "details_url": details_url
                })

            except Exception as e:
                print("Error parsing card:", e)

        # =========================
        # VISIT EACH FLOORPLAN PAGE
        # =========================
        for fp in floorplans:
            print(f"\nScraping {fp['name']}")

            goto_with_retry(page, fp["details_url"])
            wait_past_cloudflare(
                page,
                ".fp-features-amenities, .fp-availApt-Container, .no-units",
            )

            # FEATURES
            features = []
            feature_elements = page.query_selector_all(".fp-features-amenities li")

            for el in feature_elements:
                text = el.inner_text().strip()
                if text:
                    features.append(text)

            fp["features"] = "|".join(features)

            # AVAILABLE UNITS
            units = []
            unit_elements = page.query_selector_all(".fp-availApt-Container")

            for unit in unit_elements:
                try:
                    text = unit.inner_text()

                    unit_number_match = re.search(r"#(\d+)", text)
                    unit_number = unit_number_match.group(1) if unit_number_match else None

                    rent = extract_price(text)

                    apply_link_el = unit.query_selector("a")
                    apply_url = apply_link_el.get_attribute("href") if apply_link_el else None
                    apply_url = urljoin(fp["details_url"], apply_url) if apply_url else None

                    if unit_number:
                        units.append({
                            "unit_number": unit_number,
                            "rent": rent,
                            "available": True,
                            "apply_url": apply_url
                        })

                except Exception as e:
                    print("Error parsing unit:", e)

            fp["units"] = units
            data.append(fp)

        context.close()

    return data


# =========================
# SAVE TO DB
# =========================
def save_to_supabase(data):
    property_id = get_property_id()

    reset_all_units_unavailable(property_id)

    for fp in data:
        floorplan_id = upsert_floorplan(property_id, fp)

        for unit in fp["units"]:
            update_available_unit(property_id, floorplan_id, fp, unit)


# =========================
# RUN
# =========================
if __name__ == "__main__":
    result = scrape()
    save_to_supabase(result)

    print("\nFINAL RESULT:")
    for fp in result:
        print(fp["name"], "->", len(fp["units"]), "units")