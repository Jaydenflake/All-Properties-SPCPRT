from playwright.sync_api import sync_playwright
from supabase import create_client
import os
import re
from urllib.parse import urljoin

# Set PLAYWRIGHT_HEADLESS=0 to open a visible Chromium window (default: headless for CLI stability).
HEADLESS = os.environ.get("PLAYWRIGHT_HEADLESS", "1").lower() in ("1", "true", "yes")

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

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=HEADLESS)
        page = browser.new_page()

        page.goto(BASE_URL)
        page.wait_for_timeout(3000)

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

            page.goto(fp["details_url"])
            page.wait_for_timeout(3000)

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

        browser.close()

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