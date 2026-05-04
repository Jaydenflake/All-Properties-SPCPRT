import os
import re
import sys
import time
import random
from urllib.parse import urljoin

# ---------------------------------------------------------------------------
# DRIVER IMPORT — try patchright first (removes deeper automation tells that
# add_init_script cannot reach: Runtime.enable detection, console.debug
# listener, function.toString patches). Falls back to stock Playwright.
# ---------------------------------------------------------------------------
try:
    from patchright.sync_api import sync_playwright, TimeoutError as PWTimeoutError
    _USING_PATCHRIGHT = True
except ImportError:
    from playwright.sync_api import sync_playwright, TimeoutError as PWTimeoutError
    _USING_PATCHRIGHT = False

from supabase import create_client

# =========================
# CONFIG
# =========================
_HEADLESS_RAW = os.environ.get("PLAYWRIGHT_HEADLESS", "0").strip().lower()
HEADLESS = _HEADLESS_RAW in ("1", "true", "yes", "y", "on")

# Sandbox persistent profile (used unless USE_REAL_CHROME_PROFILE=1).
USER_DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".pw-profile2")

# Real Chrome profile mode — set USE_REAL_CHROME_PROFILE=1 to point at your
# actual Chrome profile (months of history = strongest CF pass signal).
# Close ALL Chrome windows before running when this is enabled.
USE_REAL_CHROME_PROFILE = os.environ.get("USE_REAL_CHROME_PROFILE", "0").strip().lower() in ("1", "true", "yes")
REAL_CHROME_PROFILE_DIR = os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\User Data")
PROFILE_NAME = os.environ.get("CHROME_PROFILE_NAME", "Default")  # e.g. "Profile 1"

# API sniffer — set API_SNIFF=1 to capture JSON endpoints for future direct-API work.
API_SNIFF = os.environ.get("API_SNIFF", "0").strip().lower() in ("1", "true", "yes")
SNIFF_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".api-sniff.log")
INTERESTING_KEYS = ("floorplan", "availability", "unit", "rent", "apartments", "leasing")

# =========================
# SUPABASE CONFIG
# =========================
SUPABASE_URL = "https://rqomxflhuxnivwkdrwbv.supabase.co"
SUPABASE_SERVICE_ROLE_KEY = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJxb214ZmxodXhuaXZ3a2R"
    "3cmJ2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NzU1ODgyMiwiZXhwIjoyMDkzMTM0ODIyfQ."
    "nkp1CKQM_oGH4niEuyi5OrEG7x9Lm7-S-QzAQxPvXCQ"
)
supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

HOME_URL  = "https://canyonvista-apts.securecafe.com/"
BASE_URL  = "https://canyonvista-apts.securecafe.com/onlineleasing/canyon-vista2/floorplans"
PROPERTY_NAME = "Canyon Vista Apartments"

# =========================
# STEALTH INIT SCRIPT
# Injected before any page JS runs. patchright covers the deeper tells;
# this handles the remaining surface-level checks.
# =========================
STEALTH_JS = """
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
Object.defineProperty(navigator, 'plugins', {
    get: () => [1, 2, 3, 4, 5].map(() => ({
        name: '', filename: '', description: '', version: ''
    }))
});
window.chrome = window.chrome || { runtime: {}, loadTimes: () => {}, csi: () => {} };
const _origPermQuery = navigator.permissions && navigator.permissions.query;
if (_origPermQuery) {
    navigator.permissions.query = function(p) {
        if (p && p.name === 'notifications') {
            return Promise.resolve({ state: Notification.permission });
        }
        return _origPermQuery.call(navigator.permissions, p);
    };
}
"""


# =========================
# HUMAN-BEHAVIOR HELPERS
# =========================
def _jitter(lo, hi):
    return random.randint(lo, hi)


def human_pause(page, lo=900, hi=2400):
    page.wait_for_timeout(_jitter(lo, hi))


def human_mouse_move(page, target_x, target_y, steps=20):
    """Move mouse from near center toward target_x/y along a slightly noisy arc."""
    try:
        start = page.evaluate(
            "() => [window.innerWidth/2 + (Math.random()-0.5)*200,"
            " window.innerHeight/2 + (Math.random()-0.5)*200]"
        )
        sx, sy = start[0], start[1]
    except Exception:
        sx, sy = 640, 450
    for i in range(1, steps + 1):
        t = i / steps
        nx = sx + (target_x - sx) * t + random.uniform(-3, 3)
        ny = sy + (target_y - sy) * t + random.uniform(-3, 3)
        try:
            page.mouse.move(nx, ny)
        except Exception:
            break
        page.wait_for_timeout(random.randint(8, 22))


def human_scroll(page, total=600):
    """Scroll down in 3-5 small wheel events, like a human reading the page."""
    remaining = total
    while remaining > 0:
        delta = random.randint(120, 220)
        try:
            page.mouse.wheel(0, delta)
        except Exception:
            break
        remaining -= delta
        page.wait_for_timeout(random.randint(120, 380))


def human_click(page, locator):
    """Scroll element into view, arc the mouse toward it, hover briefly, then click."""
    locator.scroll_into_view_if_needed()
    human_pause(page, 400, 900)
    try:
        box = locator.bounding_box()
        if box:
            target_x = box["x"] + box["width"] / 2 + random.uniform(-6, 6)
            target_y = box["y"] + box["height"] / 2 + random.uniform(-4, 4)
            human_mouse_move(page, target_x, target_y)
            human_pause(page, 250, 600)
    except Exception:
        pass
    locator.click()


# =========================
# CORE HELPERS
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


def _is_browser_closed(e):
    msg = str(e).lower()
    return "target closed" in msg or "browser has been closed" in msg or "browser or context has been closed" in msg


def wait_past_cloudflare(page, target_selector: str, timeout_ms: int = 180_000):
    """Poll until target_selector is visible. If CF appears, prompt once. If browser closes, exit cleanly."""
    deadline = time.time() + timeout_ms / 1000
    notified = False
    while time.time() < deadline:
        try:
            page.wait_for_selector(target_selector, timeout=2000, state="visible")
            return
        except PWTimeoutError:
            pass
        except Exception as e:
            if _is_browser_closed(e):
                print(
                    "\n[!] The browser window was closed.\n"
                    "    Cookies saved. Run cv-warmup.py first next time,\n"
                    "    then rerun CV-Scrape2.py.\n"
                )
                sys.exit(0)
            raise
        if _is_cloudflare(page):
            if not notified:
                print("\n[!] Cloudflare verification detected.")
                print("    -> Complete the check in the open Chrome window.")
                print("    The script will continue automatically once the page loads.\n")
                notified = True
    raise TimeoutError(f"Timed out after {timeout_ms // 1000}s waiting for: {target_selector}")


def goto_with_retry(page, url, attempts=4):
    last_err = None
    for attempt in range(1, attempts + 1):
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=120_000)
            return
        except Exception as e:
            if _is_browser_closed(e):
                print("\n[!] Browser closed during navigation. Exiting cleanly.\n")
                sys.exit(0)
            last_err = e
            if attempt < attempts:
                print(f"  [!] Navigation attempt {attempt}/{attempts} failed ({e}). Retrying in 3s...")
                time.sleep(3)
    raise last_err


# =========================
# API SNIFFER (opt-in)
# =========================
def maybe_attach_sniffer(context):
    if not API_SNIFF:
        return
    open(SNIFF_FILE, "w", encoding="utf-8").close()
    print(f"  [sniffer] Active — logging interesting JSON responses to {SNIFF_FILE}")

    def on_response(resp):
        try:
            url = resp.url
            ctype = resp.headers.get("content-type", "")
            if "application/json" not in ctype:
                return
            if not any(k in url.lower() for k in INTERESTING_KEYS):
                return
            try:
                body_preview = resp.text()[:400].replace("\n", " ")
            except Exception:
                body_preview = "<could not read body>"
            with open(SNIFF_FILE, "a", encoding="utf-8") as f:
                f.write(f"{resp.status} {resp.request.method} {url}\n  {body_preview}\n\n")
        except Exception:
            pass

    context.on("response", on_response)


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
    supabase.table("apartment_units").update({"available": False}).eq("property_id", property_id).execute()


def upsert_floorplan(property_id, fp):
    result = (
        supabase.table("floorplans")
        .upsert(
            {
                "property_id": property_id,
                "floorplan_name": fp["name"],
                "unit_type": fp["unit_type"],
                "starting_price": fp["starting_price"],
                "available_count": fp["available_count"],
                "features": fp["features"],
                "source_url": fp["details_url"],
                "last_scraped_at": "now()",
            },
            on_conflict="property_id,floorplan_name",
        )
        .execute()
    )
    return result.data[0]["id"] if result.data else None


def update_available_unit(property_id, floorplan_id, fp, unit):
    supabase.table("apartment_units").upsert(
        {
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
            "last_scraped_at": "now()",
        },
        on_conflict="property_id,unit_number",
    ).execute()


# =========================
# PAGE PARSERS
# =========================
def parse_list_page(page):
    cards = page.query_selector_all(".fp-card")
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
            floorplans.append(
                {
                    "name": name,
                    "unit_type": unit_type,
                    "starting_price": price,
                    "available_count": available_count,
                    "details_url": details_url,
                    "features": "",
                    "units": [],
                }
            )
        except Exception as e:
            print(f"  [!] Error parsing floorplan card: {e}")
    return floorplans


def parse_detail_page(page, fp):
    features = []
    for el in page.query_selector_all(".fp-features-amenities li"):
        text = el.inner_text().strip()
        if text:
            features.append(text)
    fp["features"] = "|".join(features)

    units = []
    for unit_el in page.query_selector_all(".fp-availApt-Container"):
        try:
            text = unit_el.inner_text()
            unit_number_match = re.search(r"#(\d+)", text)
            unit_number = unit_number_match.group(1) if unit_number_match else None
            rent = extract_price(text)
            apply_link_el = unit_el.query_selector("a")
            apply_url = apply_link_el.get_attribute("href") if apply_link_el else None
            apply_url = urljoin(fp["details_url"], apply_url) if apply_url else None
            if unit_number:
                units.append({"unit_number": unit_number, "rent": rent, "available": True, "apply_url": apply_url})
        except Exception as e:
            print(f"  [!] Error parsing unit: {e}")
    fp["units"] = units


# =========================
# BROWSER LAUNCH
# =========================
def _check_chrome_profile_lock():
    """Warn and abort early if the real Chrome profile is locked (Chrome still running)."""
    lock_file = os.path.join(REAL_CHROME_PROFILE_DIR, PROFILE_NAME, "lockfile")
    # Chrome on Windows uses SingletonLock (a symlink) instead of lockfile
    singleton = os.path.join(REAL_CHROME_PROFILE_DIR, "SingletonLock")
    if os.path.exists(singleton):
        print(
            "\n[!] Chrome appears to be running (SingletonLock detected).\n"
            "    Close ALL Chrome windows, then rerun this script.\n"
            "    (Chrome must not be open when using USE_REAL_CHROME_PROFILE=1)\n"
        )
        sys.exit(1)


def launch_context(p):
    """
    Choose profile directory based on USE_REAL_CHROME_PROFILE env var.
    Try real Chrome (channel='chrome') first; fall back to bundled Chromium.
    Apply patchright init script either way.
    Returns (context, used_real_chrome: bool).
    """
    if USE_REAL_CHROME_PROFILE:
        _check_chrome_profile_lock()
        profile_dir = REAL_CHROME_PROFILE_DIR
        args = [
            "--disable-blink-features=AutomationControlled",
            f"--profile-directory={PROFILE_NAME}",
        ]
    else:
        profile_dir = USER_DATA_DIR
        args = ["--disable-blink-features=AutomationControlled"]

    common_kwargs = dict(
        headless=HEADLESS,
        viewport={"width": 1280, "height": 900},
        args=args,
    )

    try:
        context = p.chromium.launch_persistent_context(
            profile_dir,
            channel="chrome",
            user_agent=None,
            **common_kwargs,
        )
        context.add_init_script(STEALTH_JS)
        return context, True
    except Exception as e:
        print(f"\n  [!] Could not launch real Chrome (channel='chrome'): {e}")
        print("      Falling back to Playwright/Patchright bundled Chromium.\n")
        ua = (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        )
        context = p.chromium.launch_persistent_context(
            USER_DATA_DIR,
            user_agent=ua,
            **common_kwargs,
        )
        context.add_init_script(STEALTH_JS)
        return context, False


# =========================
# SCRAPER
# =========================
def scrape():
    data = []

    with sync_playwright() as p:
        context, used_real_chrome = launch_context(p)

        # ── STARTUP BANNER ────────────────────────────────────
        driver_name   = "patchright" if _USING_PATCHRIGHT else "playwright (patchright not installed)"
        chrome_status = "real Chrome" if used_real_chrome else "bundled Chromium (fallback)"
        if USE_REAL_CHROME_PROFILE:
            profile_label = f"real user profile  @ {REAL_CHROME_PROFILE_DIR}\\{PROFILE_NAME}"
        else:
            profile_label = f"sandbox profile    @ {USER_DATA_DIR}"
        mode_status   = "HEADLESS" if HEADLESS else "VISIBLE WINDOW"
        sniff_status  = f"ACTIVE -> {SNIFF_FILE}" if API_SNIFF else "off (set API_SNIFF=1 to enable)"

        print(
            f"\n{'='*60}\n"
            f"  CV-Scrape2 — Canyon Vista RentCafe Scraper\n"
            f"  Driver    : {driver_name}\n"
            f"  Browser   : {chrome_status}\n"
            f"  Profile   : {profile_label}\n"
            f"  Mode      : {mode_status}\n"
            f"  Sniffer   : {sniff_status}\n"
            f"  Reminder  : Do NOT close the window. Press Ctrl+C to abort.\n"
            f"{'='*60}\n"
        )

        if HEADLESS:
            print(
                "  [!] HEADLESS is ON — no window. To pass Cloudflare run:\n"
                "        $env:PLAYWRIGHT_HEADLESS='0'; python .\\CV-Scrape2.py\n"
            )
        else:
            print(
                "  [*] Chrome is opening. If Cloudflare appears, complete it.\n"
                "      Keep the window open until 'FINAL RESULT' prints here.\n"
            )

        maybe_attach_sniffer(context)
        page = context.pages[0] if context.pages else context.new_page()

        # ── HOMEPAGE FIRST (builds referer chain) ─────────────
        print("  -> Loading homepage to build referer chain...")
        goto_with_retry(page, HOME_URL)
        human_pause(page, 1500, 3500)
        human_scroll(page, total=random.randint(300, 500))

        # ── LIST PAGE ──────────────────────────────────────────
        print("  -> Navigating to floorplans list...")
        goto_with_retry(page, BASE_URL)
        wait_past_cloudflare(page, ".fp-card")
        floorplans = parse_list_page(page)
        print(f"\nFound {len(floorplans)} floorplans on list page.")

        # ── DETAIL PAGES (click-through, human behavior) ───────
        for idx, fp in enumerate(floorplans):
            print(f"\n[{idx + 1}/{len(floorplans)}] Scraping: {fp['name']}")

            human_scroll(page, total=random.randint(200, 500))
            human_pause(page, 1200, 2800)

            navigated = False
            try:
                link = page.locator("a.btn-viewDetails").nth(idx)
                human_click(page, link)
                navigated = True
            except Exception as e:
                print(f"  [!] human_click failed ({e}). Falling back to goto...")

            if not navigated:
                goto_with_retry(page, fp["details_url"])

            wait_past_cloudflare(
                page,
                ".fp-features-amenities, .fp-availApt-Container, .no-units",
            )
            human_scroll(page, total=random.randint(300, 700))
            parse_detail_page(page, fp)
            print(f"  -> {len(fp['units'])} available units found.")
            data.append(fp)

            page.go_back()
            try:
                wait_past_cloudflare(page, ".fp-card", timeout_ms=60_000)
            except TimeoutError:
                print("  [!] List page stale after back — reloading...")
                goto_with_retry(page, BASE_URL)
                wait_past_cloudflare(page, ".fp-card")

            # Slow, human-like pause between floorplans (3-8s)
            page.wait_for_timeout(_jitter(3000, 8000))

        try:
            context.close()
        except Exception:
            pass

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
# ENTRY POINT
# =========================
if __name__ == "__main__":
    try:
        result = scrape()
    except KeyboardInterrupt:
        print("\n[*] Interrupted by user. Cookies saved to profile. Exiting.\n")
        sys.exit(0)

    if result:
        save_to_supabase(result)
    else:
        print("\n[!] No data scraped — Supabase not updated.")

    print("\nFINAL RESULT:")
    for fp in result:
        print(f"  {fp['name']} -> {len(fp['units'])} units")

    if API_SNIFF and os.path.exists(SNIFF_FILE):
        size = os.path.getsize(SNIFF_FILE)
        if size > 0:
            print(f"\n[sniffer] {SNIFF_FILE} ({size} bytes) — inspect for RentCafe API endpoints.")
        else:
            print("\n[sniffer] No interesting JSON responses were captured.")
