"""
cv-warmup.py — One-shot Cloudflare cookie seeder for CV-Scrape2.py
===================================================================
Run this ONCE before running CV-Scrape2.py (especially after a failed run
or a fresh profile). It opens the Canyon Vista site in the same persistent
profile, lets you complete the Cloudflare check and browse manually, then
saves cookies cleanly when you press Enter.

Usage:
  python .\\cv-warmup.py

  # To warm the real Chrome profile instead of the sandbox:
  $env:USE_REAL_CHROME_PROFILE='1'; python .\\cv-warmup.py

IMPORTANT: Press Enter in THIS terminal when done. Do NOT close the Chrome
window with the X button — that is what poisons future runs.
"""

import os
import sys

try:
    from patchright.sync_api import sync_playwright
    _USING_PATCHRIGHT = True
except ImportError:
    from playwright.sync_api import sync_playwright
    _USING_PATCHRIGHT = False

# Mirror the same profile config as CV-Scrape2.py
USER_DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".pw-profile2")
USE_REAL_CHROME_PROFILE = os.environ.get("USE_REAL_CHROME_PROFILE", "0").strip().lower() in ("1", "true", "yes")
REAL_CHROME_PROFILE_DIR = os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\User Data")
PROFILE_NAME = os.environ.get("CHROME_PROFILE_NAME", "Default")

HOME_URL     = "https://canyonvista-apts.securecafe.com/"
FLOORPLAN_URL = "https://canyonvista-apts.securecafe.com/onlineleasing/canyon-vista2/floorplans"

STEALTH_JS = """
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
Object.defineProperty(navigator, 'plugins', {
    get: () => [1, 2, 3, 4, 5].map(() => ({
        name: '', filename: '', description: '', version: ''
    }))
});
window.chrome = window.chrome || { runtime: {}, loadTimes: () => {}, csi: () => {} };
"""


def _check_singleton_lock():
    singleton = os.path.join(REAL_CHROME_PROFILE_DIR, "SingletonLock")
    if os.path.exists(singleton):
        print(
            "\n[!] Chrome appears to be running (SingletonLock detected).\n"
            "    Close ALL Chrome windows, then rerun this script.\n"
        )
        sys.exit(1)


def main():
    driver_name = "patchright" if _USING_PATCHRIGHT else "playwright"

    if USE_REAL_CHROME_PROFILE:
        _check_singleton_lock()
        profile_dir = REAL_CHROME_PROFILE_DIR
        args = [
            "--disable-blink-features=AutomationControlled",
            f"--profile-directory={PROFILE_NAME}",
        ]
        profile_label = f"real user profile @ {REAL_CHROME_PROFILE_DIR}\\{PROFILE_NAME}"
    else:
        profile_dir = USER_DATA_DIR
        args = ["--disable-blink-features=AutomationControlled"]
        profile_label = f"sandbox profile  @ {USER_DATA_DIR}"

    print(
        f"\n{'='*60}\n"
        f"  cv-warmup — Canyon Vista Cookie Seeder\n"
        f"  Driver  : {driver_name}\n"
        f"  Profile : {profile_label}\n"
        f"{'='*60}\n"
    )

    with sync_playwright() as p:
        try:
            context = p.chromium.launch_persistent_context(
                profile_dir,
                channel="chrome",
                headless=False,
                viewport={"width": 1280, "height": 900},
                args=args,
            )
        except Exception as e:
            print(f"  [!] Real Chrome not found ({e}). Falling back to bundled Chromium.")
            context = p.chromium.launch_persistent_context(
                USER_DATA_DIR,
                headless=False,
                viewport={"width": 1280, "height": 900},
                args=["--disable-blink-features=AutomationControlled"],
                user_agent=(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
                ),
            )

        context.add_init_script(STEALTH_JS)
        page = context.pages[0] if context.pages else context.new_page()

        try:
            page.goto(HOME_URL, wait_until="domcontentloaded", timeout=60_000)
        except Exception as e:
            print(f"  [!] Could not load homepage: {e}")

        print(
            "\n[*] Warm-up mode — Chrome is now open.\n"
            "\n"
            "    Do the following IN THE CHROME WINDOW:\n"
            "      1. Complete the Cloudflare verification if it appears.\n"
            "      2. Browse to the floorplans page and click into 2-3 floorplans.\n"
            "      3. Scroll around each page a little — behave like a human.\n"
            "\n"
            "    When you are done browsing:\n"
            "      -> Press  Enter  here in this terminal (do NOT close Chrome with X).\n"
            "\n"
            "    Pressing Enter saves the cf_clearance cookie to the profile so\n"
            "    CV-Scrape2.py can reuse it without a fresh Cloudflare challenge.\n"
        )

        try:
            input("  Press Enter when you are done browsing > ")
        except (EOFError, KeyboardInterrupt):
            print("\n[*] Interrupted.")

        print("\n  Saving cookies and closing browser cleanly...")
        try:
            context.close()
        except Exception:
            pass

    print(
        "\n[*] Warm-up complete. Profile cookies saved.\n"
        "    You can now run:\n"
        "      python .\\CV-Scrape2.py\n"
    )


if __name__ == "__main__":
    main()
