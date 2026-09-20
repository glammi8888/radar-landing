#!/usr/bin/env python3
"""
Builds web/standalone.html - one self-contained file you can double-click or
host anywhere. Generated from index.html + _shared.css + the three scripts, so
scoring.js stays the single source of truth that parity-test.mjs checks.

    python3 web/build.py
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
read = lambda n: open(os.path.join(HERE, n), encoding="utf-8").read()

html = read("index.html")
# Take the CSS straight from the local dashboard so there is one source of
# truth for styling and the two builds cannot drift apart visually.
dash = open(os.path.join(HERE, "..", "dashboard.html"), encoding="utf-8").read()
css = dash[dash.index("<style>") + 7:dash.index("</style>")]
html = html.replace("/*CSS*/", css)
html = html.replace("/*SCORING*/", read("scoring.js"))
html = html.replace("/*APP*/", read("app.js") + "\n" + read("ui.js") + "\n" + read("wiring.js"))

# A standalone file must not reach for a CommonJS module object.
html = html.replace("if (typeof module !== 'undefined' && module.exports) module.exports = S;", "")

out = os.path.join(HERE, "standalone.html")
with open(out, "w", encoding="utf-8") as fh:
    fh.write(html)

leftovers = [m for m in ("/*CSS*/", "/*SCORING*/", "/*APP*/") if m in html]
assert not leftovers, f"placeholders not replaced: {leftovers}"
assert "<script src=" not in html, "standalone must have no external scripts"
print(f"standalone.html written: {len(html)/1024:.0f} KB, no external dependencies")
