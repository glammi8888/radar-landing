# App Opportunity Scout — browser build

**No install, no terminal, no server.** Open `standalone.html` and it works.

- **Double-click `standalone.html`** — runs from your own disk, fully private.
- Or host it anywhere over **HTTPS** and use it from your phone.

One self-contained file, ~69 KB, no external dependencies. All data stays in your browser's
`localStorage`; nothing is uploaded anywhere.

---

## How it talks to Apple

`itunes.apple.com` sends **no CORS headers**, so a page can't `fetch()` it. Every call here is
**JSONP** — a `<script>` tag with `?callback=` — which Apple does support.

JSONP is GET-only and **cannot set request headers**. That single fact causes the one real
difference from the local build:

> **Apple's autocomplete endpoint needs an `X-Apple-Store-Front` header, so it is unreachable
> here.** Demand confidence therefore **tops out at LOW** and is inferred from how many
> competitors target the term. The local build reaches MEDIUM.

Everything else — the Top-10 distribution, entry bar, small-app rank evidence, competitor
strength, traction, review mining, exports — is **identical**, and proven so (see below).

Must be served over **HTTPS** (or opened as a local file). On plain `http://` the browser blocks
Apple's HTTPS script as mixed content; the page detects this and says so.

## Files

```
standalone.html   the built, self-contained app        <- this is the one you open
index.html        page shell with placeholders
scoring.js        the model, ported from scout.py      <- single source of truth
app.js            JSONP fetching, cache, storage, research run
ui.js             table, detail view, exports
wiring.js         event wiring and boot
build.py          inlines everything into standalone.html
parity-test.mjs   proves the JS model matches the Python one
```

After editing any of `index.html`, `scoring.js`, `app.js`, `ui.js`, `wiring.js`, or the local
`dashboard.html` (which supplies the CSS), rebuild:

```bash
python3 web/build.py
```

## Keeping the two models honest

`scoring.js` is a deliberate port of the model in `scout.py`. Two implementations of the same
maths will drift unless something stops them, so:

```bash
python3 parity.py && node web/parity-test.mjs
```

`parity.py` runs seven SERP shapes (including both worked examples from the brief) through the
Python model and writes `parity-golden.json`. `parity-test.mjs` replays the identical fixtures
through the JavaScript and compares **1,791 values**. Any divergence fails.

It has already earned its keep twice: it caught the JS sorting the rating ladder by size instead
of by SERP position, and a rounding helper that mis-classified values a hair above `.5` as exact
ties.

Run both whenever you touch the model in either language.

## Rate limits and storage

- **~20 requests/minute** to Apple, unauthenticated. Requests are spaced 3.5s apart, so 30
  keywords takes about 2 minutes. Results cache for 7 days.
- **Keep the tab open** while a run is in progress.
- `localStorage` holds roughly 5 MB. Descriptions are stored as 600-character excerpts and the
  response cache is trimmed to its 300 most recent entries. If storage fills up the page says so
  and tells you to export — it will not fail silently.
- **Export to JSON** before clearing your browser data. That file is your only backup.

## What it still refuses to do

Unchanged from the local build: **search volume, keyword difficulty and revenue are never
produced.** Downloads appear only as a wide range built on one visible assumption. Missing data
stays missing rather than becoming `0`. Rating count is a proxy for competitor **traction** — not
difficulty, not downloads, not demand.
