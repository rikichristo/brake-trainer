"""Build the Brake Trainer into one self-contained page.

Two outputs from the same bundle:
  artifact.html       - for publishing as a claude.ai artifact (shop window)
  brake-trainer.html  - the standalone/hosted file, which becomes index.html

The Supabase client is loaded from a CDN before the bundle, because sign-in,
the leaderboard and the run log all need it. It is deliberately a separate
script rather than bundled: if it fails to load, `cloud.ready()` is false and
the app falls back to local profiles instead of failing to start.
"""
import hashlib
import json
import pathlib
import subprocess
import sys

SRC = pathlib.Path("/mnt/user-data/outputs/BrakeTrainer.jsx")
LAPS = pathlib.Path("/home/claude/laps_out/laps.json")
SMOKE = pathlib.Path("/home/claude/smoke")
OUT_STD = pathlib.Path("/mnt/user-data/outputs/brake-trainer.html")
OUT_ART = SMOKE / "artifact.html"

SUPABASE_CDN = (
    "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js"
)

# Michroma is the closest widely available match to the VCASO wordmark. Loaded
# from Google Fonts with a preconnect; if it never arrives the stack falls back
# to the nearest grotesques and the page is unaffected.
FONT = (
    '<link rel="preconnect" href="https://fonts.googleapis.com">\n'
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
    '<link rel="stylesheet" '
    'href="https://fonts.googleapis.com/css2?family=Michroma&display=swap">\n'
)

STYLE = """<style>
  /* Single-dark by design: white reference traces on black, so there is no light theme. */
  :root{
    --bt-void:#000000;   /* trace ground */
    --bt-ink:#f2f5f4;    /* primary text */
    --bt-muted:#7b8481;  /* labels */
    color-scheme: dark;
    background: var(--bt-void);
  }
  html,body{height:100%;margin:0;background:var(--bt-void);color:var(--bt-ink);}
  #root{min-height:100%;background:var(--bt-void);}
  #boot{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;
        padding:0 16px;text-align:center;background:var(--bt-void);color:var(--bt-muted);
        font:15px ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;}
</style>"""

BOOTJS = """<script>
  (function () {
    var boot = function () { return document.getElementById('boot'); };
    var failed = false;
    window.addEventListener('error', function (e) {
      var b = boot(); failed = true;
      if (b) { b.textContent = 'Could not start: ' + (e.message || 'unknown error'); b.style.color = '#ff6b5e'; }
    });
    window.addEventListener('unhandledrejection', function (e) {
      var b = boot(); failed = true;
      if (b) { b.textContent = 'Could not start: ' + ((e.reason && e.reason.message) || e.reason || 'unknown'); b.style.color = '#ff6b5e'; }
    });
    var waited = 0;
    var t = setInterval(function () {
      var root = document.getElementById('root'), b = boot();
      if (root && root.children.length > 0) { clearInterval(t); if (b) b.remove(); return; }
      waited += 100;
      if (waited >= 4000) {
        clearInterval(t);
        if (b && !failed) { b.textContent = 'The app script ran but rendered nothing.'; b.style.color = '#e3b45a'; }
      }
    }, 100);
  })();
</script>"""

ICON = (
    "data:image/svg+xml,"
    "%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E"
    "%3Crect width='32' height='32' fill='%23000'/%3E"
    "%3Cpath d='M2 26 L9 26 L11 7 L14 9 L17 14 L22 22 L26 26 L30 26' "
    "fill='none' stroke='%23fff' stroke-width='2.4' stroke-linejoin='round' stroke-linecap='round'/%3E"
    "%3C/svg%3E"
)

# Only the hosted copy can resolve these, and only the hosted copy is ever
# added to a home screen. Without an explicit apple-touch-icon, iOS falls back
# to whatever it can find at the root of the origin — and rikichristo.github.io
# hosts more than one site, so the trainer was showing another one's icon.
ICONS = (
    '<link rel="apple-touch-icon" href="apple-touch-icon.png">\n'
    '<link rel="icon" type="image/png" sizes="32x32" href="favicon-32.png">\n'
    '<link rel="manifest" href="manifest.webmanifest">\n'
    '<meta name="apple-mobile-web-app-title" content="Brake Trainer">\n'
    '<meta name="apple-mobile-web-app-capable" content="yes">\n'
    '<meta name="apple-mobile-web-app-status-bar-style" content="black">\n'
    '<meta name="theme-color" content="#000000">\n'
)

HEAD = (
    '<meta charset="utf-8">\n'
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
    "<title>Brake Trainer</title>\n"
    '<meta name="description" content="Follow a real reference lap with your own pedals.">\n'
    f'<link rel="icon" href="{ICON}">\n'
)


def main() -> int:
    src = SRC.read_text()
    data = LAPS.read_text()
    if "__LAP_DATA__" not in src:
        print("!! __LAP_DATA__ placeholder missing from the source")
        return 1
    (SMOKE / "src" / "BrakeTrainer.jsx").write_text(src.replace("__LAP_DATA__", data))

    r = subprocess.run(
        ["npx", "--yes", "esbuild", "src/main.jsx", "--bundle", "--format=iife",
         "--minify", '--define:process.env.NODE_ENV="production"',
         "--outfile=bundle.js", "--log-level=error"],
        cwd=SMOKE, capture_output=True, text=True,
    )
    if r.returncode != 0:
        print(r.stdout)
        print(r.stderr)
        return r.returncode

    bundle = (SMOKE / "bundle.js").read_text()
    supa = f'<script src="{SUPABASE_CDN}"></script>'

    art = (
        f"<title>Brake Trainer</title>\n{FONT}{STYLE}\n\n"
        '<div id="root"></div>\n<div id="boot">Loading Brake Trainer&hellip;</div>\n\n'
        f"{BOOTJS}\n\n{supa}\n<script>\n{bundle}\n</script>\n"
    )
    OUT_ART.write_text(art)

    std = (
        f'<!doctype html>\n<html lang="en">\n<head>\n{HEAD}{ICONS}{FONT}{STYLE}\n</head>\n<body>\n'
        '<div id="root"></div>\n<div id="boot">Loading Brake Trainer&hellip;</div>\n\n'
        f"{BOOTJS}\n\n{supa}\n<script>\n{bundle}\n</script>\n</body>\n</html>\n"
    )
    OUT_STD.write_text(std)

    md5 = hashlib.md5(std.encode()).hexdigest()[:12]
    print(f"built {len(std) // 1024} KB  md5 {md5}")
    print(f"  artifact {len(art) // 1024} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
