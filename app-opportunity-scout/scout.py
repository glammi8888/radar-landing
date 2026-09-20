#!/usr/bin/env python3
"""
APP OPPORTUNITY SCOUT
=====================
Local ASO opportunity research for the US iPhone App Store.

Run:  python3 scout.py           -> dashboard on http://localhost:8787
      python3 scout.py --port N  -> different port

Zero third-party dependencies. Python 3.9+.

DATA HONESTY RULES (enforced in code, not just docs):
  * Nothing is invented. A metric we cannot source is emitted as None and
    rendered as UNAVAILABLE.
  * Every app field carries its provenance via PROVENANCE below.
  * Search volume / difficulty / downloads / revenue are NEVER produced.
"""

import csv
import io
import json
import os
import plistlib
import re
import statistics
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(ROOT, "cache")
SESSION_DIR = os.path.join(ROOT, "sessions")
EXPORT_DIR = os.path.join(ROOT, "exports")
for _d in (CACHE_DIR, SESSION_DIR, EXPORT_DIR):
    os.makedirs(_d, exist_ok=True)

COUNTRY = "us"
STOREFRONT = "143441-1,29"          # US storefront header for the hints endpoint
CACHE_TTL = 7 * 24 * 3600           # 7 days
REQUEST_SPACING = 3.5               # seconds; iTunes API is ~20 req/min per IP
SERP_DEPTH = 20                     # top N apps per keyword
USER_AGENT = "AppOpportunityScout/1.0 (local research tool)"

# ---------------------------------------------------------------------------
# Provenance: what each field is and where it came from. Surfaced in the UI.
# ---------------------------------------------------------------------------
PROVENANCE = {
    "verified":    "Verified public data returned directly by an Apple endpoint.",
    "calculated":  "Computed by this tool from verified public data. Formula shown.",
    "subjective":  "Your own 1-5 rating. Not data.",
    "proxy":       "An indirect signal, not the metric itself. Treat as directional.",
    "unavailable": "Requires a paid/proprietary ASO provider or credentials we do not have.",
}

SEED_KEYWORDS = [
    "guided visualization", "visualization", "visualization app", "guided imagery",
    "mental rehearsal", "future self", "success visualization",
    "confidence visualization", "manifestation visualization",
    "mindset", "mindset coach", "motivation", "motivation coach", "daily motivation",
    "confidence", "confidence coach", "self confidence", "manifestation",
    "affirmations", "mental reset", "mindset reset", "focus", "focus coach",
    "procrastination", "overthinking", "creative block", "inspiration",
    "discipline", "personal growth", "life coach",
]


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "kw"


# ---------------------------------------------------------------------------
# HTTP with disk cache + global rate limiting
# ---------------------------------------------------------------------------
class Fetcher:
    """Rate-limited, disk-cached HTTP GET. Never raises; returns (data, error)."""

    def __init__(self):
        self._lock = threading.Lock()
        self._last_request = 0.0
        self.live_calls = 0

    def _cache_path(self, url):
        import hashlib
        return os.path.join(CACHE_DIR, hashlib.sha1(url.encode()).hexdigest() + ".json")

    def _throttle(self):
        with self._lock:
            delta = time.time() - self._last_request
            if delta < REQUEST_SPACING:
                time.sleep(REQUEST_SPACING - delta)
            self._last_request = time.time()

    def get(self, url, headers=None, parse="json", force=False):
        """Returns (payload, error_string). payload is None on failure."""
        path = self._cache_path(url)
        if not force and os.path.exists(path):
            try:
                with open(path) as fh:
                    blob = json.load(fh)
                if time.time() - blob["fetched_at"] < CACHE_TTL:
                    return blob["payload"], None
            except Exception:
                pass

        self._throttle()
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read()
            self.live_calls += 1
        except urllib.error.HTTPError as exc:
            if exc.code == 403:
                return None, "403 from Apple - rate limited or blocked. Wait a minute and retry."
            return None, f"HTTP {exc.code} for {url}"
        except Exception as exc:
            return None, f"{type(exc).__name__}: {exc}"

        try:
            if parse == "json":
                payload = json.loads(raw.decode("utf-8", "replace"))
            elif parse == "plist":
                payload = plistlib.loads(raw)
            else:
                payload = raw.decode("utf-8", "replace")
        except Exception as exc:
            return None, f"Could not parse response from {url}: {exc}"

        try:
            with open(path, "w") as fh:
                json.dump({"fetched_at": time.time(), "url": url, "payload": payload}, fh)
        except Exception:
            pass
        return payload, None


FETCHER = Fetcher()


# ---------------------------------------------------------------------------
# PHASE 2 - App Store SERP (via iTunes Search API)
# ---------------------------------------------------------------------------
def fetch_serp(keyword, force=False):
    """
    Returns (apps, meta, error).

    IMPORTANT: this is the iTunes Search API's relevance order. It is NOT the
    App Store's live search ranking. We do not scrape apps.apple.com/search
    because robots.txt disallows /search. Composition of this result set is
    reliable; exact ordinal position is a proxy.
    """
    url = "https://itunes.apple.com/search?" + urllib.parse.urlencode({
        "term": keyword, "country": COUNTRY, "media": "software",
        "entity": "software", "limit": SERP_DEPTH,
    })
    payload, err = FETCHER.get(url, force=force)
    if err:
        return [], {}, err

    apps = []
    for i, raw in enumerate(payload.get("results", []), start=1):
        apps.append(normalise_app(raw, position=i, keyword=keyword))
    meta = {
        "resultCount": payload.get("resultCount"),
        "source": "iTunes Search API",
        "sourceUrl": url,
        "rankingCaveat": ("iTunes Search API relevance order - a proxy for the App Store SERP, "
                          "not identical to it."),
        "fetchedAt": now_iso(),
    }
    return apps, meta, None


def normalise_app(raw, position, keyword):
    """Map an iTunes Search API record to our schema. Missing -> None, never 0."""
    def g(key):
        val = raw.get(key)
        return None if val in ("", [], {}) else val

    release = g("releaseDate")
    age_days = None
    if release:
        try:
            dt = datetime.fromisoformat(release.replace("Z", "+00:00"))
            age_days = (datetime.now(timezone.utc) - dt).days
        except Exception:
            age_days = None

    updated = g("currentVersionReleaseDate")
    days_since_update = None
    if updated:
        try:
            dt = datetime.fromisoformat(updated.replace("Z", "+00:00"))
            days_since_update = (datetime.now(timezone.utc) - dt).days
        except Exception:
            days_since_update = None

    title = g("trackName") or ""
    kw = keyword.lower().strip()
    title_l = title.lower()
    kw_tokens = [t for t in kw.split() if t]

    price = g("price")
    formatted = g("formattedPrice")
    shots = raw.get("screenshotUrls") or []

    return {
        "position": position,
        # --- verified -------------------------------------------------------
        "trackId": g("trackId"),
        "name": title or None,
        "developer": g("sellerName") or g("artistName"),
        "url": g("trackViewUrl"),
        "category": g("primaryGenreName"),
        "genres": raw.get("genres") or None,
        "rating": g("averageUserRating"),
        "ratingCount": raw.get("userRatingCount"),
        "ratingCurrentVersion": g("averageUserRatingForCurrentVersion"),
        "ratingCountCurrentVersion": raw.get("userRatingCountForCurrentVersion"),
        "price": price,
        "formattedPrice": formatted,
        "isFree": (price == 0) if price is not None else None,
        "version": g("version"),
        "releaseDate": release,
        "lastUpdate": updated,
        "releaseNotes": g("releaseNotes"),
        "description": g("description"),
        "icon": g("artworkUrl512") or g("artworkUrl100"),
        "screenshots": shots or None,
        "screenshotCount": len(shots) if shots else 0,
        "ipadScreenshotCount": len(raw.get("ipadScreenshotUrls") or []),
        "minimumOsVersion": g("minimumOsVersion"),
        "contentRating": g("trackContentRating"),
        "fileSizeBytes": g("fileSizeBytes"),
        "languageCount": len(raw.get("languageCodesISO2A") or []) or None,
        # --- calculated -----------------------------------------------------
        "ageDays": age_days,
        "daysSinceUpdate": days_since_update,
        "descriptionLength": len(g("description") or "") or None,
        "exactMatchInTitle": kw in title_l if title else None,
        "partialMatchInTitle": (
            bool(kw_tokens) and any(t in title_l for t in kw_tokens)) if title else None,
        # --- not available from this source ---------------------------------
        "subtitle": None,            # product page only; opt-in enricher
        "iapTiers": None,            # product page only
        "downloads": None,           # paid provider only
        "revenue": None,             # paid provider only
    }


# ---------------------------------------------------------------------------
# PHASE 3 - Competition analysis. Descriptive stats only, all from verified data.
# ---------------------------------------------------------------------------

def percentile(sorted_vals, p):
    """Linear-interpolated percentile. sorted_vals must be ascending."""
    if not sorted_vals:
        return None
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    k = (len(sorted_vals) - 1) * p
    lo, hi = math.floor(k), math.ceil(k)
    if lo == hi:
        return sorted_vals[int(k)]
    return sorted_vals[lo] * (hi - k) + sorted_vals[hi] * (k - lo)


def spearman(xs, ys):
    """Rank correlation. Descriptive only - never feeds a score."""
    n = len(xs)
    if n < 3:
        return None

    def ranks(v):
        order = sorted(range(n), key=lambda i: v[i])
        out = [0] * n
        for pos, i in enumerate(order):
            out[i] = pos + 1
        return out

    rx, ry = ranks(xs), ranks(ys)
    mx, my = sum(rx) / n, sum(ry) / n
    num = sum((rx[i] - mx) * (ry[i] - my) for i in range(n))
    den = (sum((rx[i] - mx) ** 2 for i in range(n))
           * sum((ry[i] - my) ** 2 for i in range(n))) ** 0.5
    return round(num / den, 3) if den else None


def penetration(top10):
    """
    THE CENTRAL QUESTION: can relatively small / new apps rank for this keyword?

    Answered from the observed SERP distribution, not from a pass/fail threshold.
    Rating count is used here strictly as a proxy for COMPETITOR TRACTION. It is
    not keyword difficulty, not downloads, and not search demand.

    The key number is the ENTRY BAR - the smallest rating count that still holds
    a top-10 slot. You do not have to match the median to rank; you have to clear
    the floor. A SERP of 50k / 8k / 700 / 420 / 180 / 95 has an entry bar of 95,
    and that is the honest read of what it takes to appear.
    """
    pairs = [(a["position"], a["ratingCount"]) for a in top10
             if isinstance(a.get("ratingCount"), (int, float))]
    if not pairs:
        return None
    counts = sorted(c for _, c in pairs)
    med = statistics.median(counts)

    def best_position_under(limit):
        hits = [pos for pos, c in pairs if c < limit]
        return min(hits) if hits else None

    below_median = [(pos, c) for pos, c in pairs if c < med]
    best_below_median = min((pos for pos, _ in below_median), default=None)
    n = len(pairs)

    return {
        "ladder": [{"position": pos, "ratingCount": c} for pos, c in sorted(pairs)],
        "entryBarMin": counts[0],
        "entryBarP25": round(percentile(counts, 0.25), 1),
        "fieldMedian": med,
        # "positions occupied by smaller apps", at several sizes, no gating
        "bestPositionUnder100": best_position_under(100),
        "bestPositionUnder500": best_position_under(500),
        "bestPositionUnder1000": best_position_under(1000),
        "bestPositionUnder10000": best_position_under(10000),
        "positionsUnder500": [pos for pos, c in sorted(pairs) if c < 500],
        "positionsUnder1000": [pos for pos, c in sorted(pairs) if c < 1000],
        "belowMedianPositions": sorted(pos for pos, _ in below_median),
        "bestPositionBelowMedian": best_below_median,
        "inTop5Under1000": sum(1 for pos, c in pairs if pos <= 5 and c < 1000),
        "sizeRankCorrelation": spearman([pos for pos, _ in pairs], [-c for _, c in pairs]),
        "sampleSize": n,
        "note": ("sizeRankCorrelation near +1 means the SERP is strictly sorted big-to-small, "
                 "so position tracks size. Near 0 means size does not determine rank. "
                 "Descriptive only - it never feeds a score."),
    }


def analyse_competition(apps, keyword):
    top10 = apps[:10]
    counts = [a["ratingCount"] for a in top10 if isinstance(a["ratingCount"], (int, float))]
    stars = [a["rating"] for a in top10 if isinstance(a["rating"], (int, float))]
    missing = len(top10) - len(counts)

    if not counts:
        return {
            "sampleSize": len(top10),
            "ratingCountsMissing": missing,
            "note": "No rating counts returned for this keyword. Competition cannot be assessed.",
            "medianRatingCount": None, "avgRatingCount": None,
            "minRatingCount": None, "maxRatingCount": None,
            "under100": None, "under500": None, "under1000": None, "over10000": None,
            "pctUnder500": None, "exactInTitle": None, "inTitle": None,
            "avgStars": None, "dominantIncumbent": None, "penetration": None,
            "freshlyUpdated": None, "strength": None,
        }

    kw = keyword.lower().strip()
    exact = sum(1 for a in top10 if a.get("exactMatchInTitle"))
    partial = sum(1 for a in top10 if a.get("partialMatchInTitle"))
    median = statistics.median(counts)
    maximum = max(counts)

    # Dominant incumbent: an app whose rating mass dwarfs the field.
    # DESCRIPTIVE ONLY. This deliberately does NOT penalise the score: a big app
    # at #1 does not stop you ranking #3-#6, and excluding a keyword because a
    # large competitor exists throws away good opportunities. Thresholds below
    # are labelling heuristics, not evidence-backed cutoffs.
    dominant = None
    others = sorted(counts, reverse=True)[1:]
    median_others = statistics.median(others) if others else 0
    if maximum >= 50000 and (median_others == 0 or maximum >= 10 * max(median_others, 1)):
        top_app = max((a for a in top10 if isinstance(a["ratingCount"], (int, float))),
                      key=lambda a: a["ratingCount"])
        dominant = {
            "name": top_app["name"],
            "ratingCount": top_app["ratingCount"],
            "multipleOfFieldMedian": round(maximum / max(median_others, 1), 1),
            "scoringImpact": "none - descriptive flag only",
            "thresholdCaveat": ("Flagged at >=50,000 ratings AND >=10x the rest of the field. "
                                "Those cutoffs are labelling conventions, not evidence."),
        }

    fresh = sum(1 for a in top10
                if isinstance(a.get("daysSinceUpdate"), int) and a["daysSinceUpdate"] <= 180)

    comp = {
        "sampleSize": len(top10),
        "ratingCountsMissing": missing,
        "medianRatingCount": median,
        "avgRatingCount": round(statistics.mean(counts), 1),
        "minRatingCount": min(counts),
        "maxRatingCount": maximum,
        "under100": sum(1 for c in counts if c < 100),
        "under500": sum(1 for c in counts if c < 500),
        "under1000": sum(1 for c in counts if c < 1000),
        "over10000": sum(1 for c in counts if c > 10000),
        "pctUnder500": round(100 * sum(1 for c in counts if c < 500) / len(counts)),
        "exactInTitle": exact,
        "inTitle": partial,
        "avgStars": round(statistics.mean(stars), 2) if stars else None,
        "freshlyUpdated": fresh,
        "dominantIncumbent": dominant,
    }
    comp["penetration"] = penetration(top10)
    comp["strength"] = competitor_strength(comp)
    return comp


import math


def competitor_strength(c):
    """
    COMPETITOR STRENGTH  0-100  (higher = harder to break into).

    NOT an industry ASO Keyword Difficulty score. It is a transparent sum of
    four observable components, each worth up to 25 points:

      A. Rating mass        25 * log10(median_top10 + 1) / 5     (100k ratings = full)
      B. Incumbent ceiling  25 * log10(max_top10 + 1) / 6        (1M ratings  = full)
      C. Keyword targeting  25 * (exact + 0.5*partial) / sample  (how hard devs optimise)
      D. Entrenchment       15 * (avg_stars - 3)/2  +  10 * (fresh/sample)

    Every input is printed in the UI beside the score.
    """
    comp_a = 25 * min(math.log10(c["medianRatingCount"] + 1) / 5, 1.0)
    comp_b = 25 * min(math.log10(c["maxRatingCount"] + 1) / 6, 1.0)

    n = max(c["sampleSize"], 1)
    comp_c = 25 * min((c["exactInTitle"] + 0.5 * c["inTitle"]) / n, 1.0)

    stars = c["avgStars"]
    star_pts = 15 * min(max(((stars - 3.0) / 2.0), 0), 1) if stars is not None else 7.5
    fresh_pts = 10 * min(c["freshlyUpdated"] / n, 1.0)
    comp_d = star_pts + fresh_pts

    total = comp_a + comp_b + comp_c + comp_d
    return {
        "score": round(total),
        "band": "HIGH" if total >= 66 else ("MEDIUM" if total >= 38 else "LOW"),
        "components": {
            "ratingMass": round(comp_a, 1),
            "incumbentCeiling": round(comp_b, 1),
            "keywordTargeting": round(comp_c, 1),
            "entrenchment": round(comp_d, 1),
        },
        "formula": ("25*log10(medianTop10+1)/5 + 25*log10(maxTop10+1)/6 + "
                    "25*(exactInTitle+0.5*inTitle)/n + [15*(avgStars-3)/2 + 10*fresh/n]"),
        "provenance": "calculated",
    }


# ---------------------------------------------------------------------------
# PHASE 3B - TRACTION MODELLING
#
# This is the closest honest analogue to "downloads". It has three layers and
# the layers are NOT equally trustworthy. The UI keeps them visually separate.
#
#   L1 OBSERVED   rating counts sampled over time. Apple's own numbers. No model.
#   L2 CALCULATED velocity and momentum, arithmetic on L1. Formula shown.
#   L3 ESTIMATED  downloads = ratings / ratingRate. ONE assumption, and it is a
#                 ~10x-uncertain one, so the output is always a RANGE and the
#                 rate is a dial you control. Never a point estimate.
#
# Deliberately absent: revenue. It needs downloads x free-to-paid conversion x
# retention. Conversion is unobservable for any app but your own, so a revenue
# figure would be an assumption cubed. See README.
# ---------------------------------------------------------------------------
HISTORY_PATH = os.path.join(ROOT, "history.json")
CALIBRATION_PATH = os.path.join(ROOT, "calibration.json")
SNAPSHOT_MIN_GAP = 6 * 3600     # don't record twice within 6h

# A widely repeated industry rule of thumb, NOT a measured constant and NOT
# sourced from Apple. Real rates vary by roughly 10x across genres, and by
# whether the app uses SKStoreReviewController. The band is wide on purpose.
# Supply calibration.json to replace it with something real.
DEFAULT_RATING_RATE_BAND = (0.005, 0.05)      # 0.5% - 5% of users leave a rating

# Ceiling for "small riser". A starting point, not a law - the dashboard lets you
# move it, and growthRanking below always carries every app regardless of size.
DEFAULT_RISER_MAX_RATINGS = 500
RISER_MIN_RATE = 0.3                           # ratings/day to count as rising


def load_history():
    try:
        with open(HISTORY_PATH) as fh:
            return json.load(fh)
    except Exception:
        return {}


def save_history(hist):
    try:
        with open(HISTORY_PATH, "w") as fh:
            json.dump(hist, fh, separators=(",", ":"))
    except Exception:
        pass


def record_snapshots(apps, hist=None):
    """Append (timestamp, ratingCount, rating) per app. Deduped by time gap."""
    hist = load_history() if hist is None else hist
    now = time.time()
    for a in apps:
        tid, rc = a.get("trackId"), a.get("ratingCount")
        if tid is None or not isinstance(rc, (int, float)):
            continue
        series = hist.setdefault(str(tid), [])
        if series:
            last_ts, last_rc = series[-1][0], series[-1][1]
            if now - last_ts < SNAPSHOT_MIN_GAP and last_rc == rc:
                continue
        series.append([round(now), rc, a.get("rating")])
        if len(series) > 200:
            del series[:-200]
    return hist


def load_calibration():
    """
    Optional ground truth: real (downloads, ratings) pairs you supply, e.g. from
    your own App Store Connect, or a public disclosure. Format:
      {"pairs":[{"label":"my app","downloads":50000,"ratings":610}, ...]}
    With pairs present the rating-rate band is FITTED instead of assumed.
    """
    try:
        with open(CALIBRATION_PATH) as fh:
            blob = json.load(fh)
        rates = []
        for pair in blob.get("pairs", []):
            d, r = pair.get("downloads"), pair.get("ratings")
            if isinstance(d, (int, float)) and isinstance(r, (int, float)) and d > 0 and r >= 0:
                rates.append(r / d)
        rates = [x for x in rates if x > 0]
        if not rates:
            return None
        return {"band": (min(rates), max(rates)), "n": len(rates),
                "median": statistics.median(rates),
                "source": f"fitted from {len(rates)} ground-truth pair(s) you supplied"}
    except Exception:
        return None


def rating_rate_band():
    calib = load_calibration()
    if calib:
        return calib["band"], calib["source"], calib["n"]
    return (DEFAULT_RATING_RATE_BAND,
            "ASSUMED default band (0.5%-5%) - an industry rule of thumb, not measured data",
            0)


def estimate_downloads(ratings_per_day):
    """
    L3 ESTIMATE. downloads/day = ratings/day / ratingRate.

    Returns a RANGE, never a point, because the divisor is uncertain by ~10x.
    If the band is the default, this is arithmetic on an assumption - it tells
    you an order of magnitude and nothing finer. Marked ESTIMATED everywhere.
    """
    if ratings_per_day is None:
        return None
    (lo_rate, hi_rate), source, n = rating_rate_band()
    return {
        "perDayLow": round(ratings_per_day / hi_rate, 1),
        "perDayHigh": round(ratings_per_day / lo_rate, 1),
        "perMonthLow": round(ratings_per_day / hi_rate * 30),
        "perMonthHigh": round(ratings_per_day / lo_rate * 30),
        "ratingRateBand": [lo_rate, hi_rate],
        "calibrationPairs": n,
        "assumption": source,
        "provenance": "estimated",
        "health": ("CALIBRATED against your own data" if n else
                   "UNCALIBRATED - this is an assumption, not a measurement"),
        "warning": ("Dividing every app by the same rate does not change which keyword ranks "
                    "highest. This adds a sense of absolute scale, not ranking information."),
    }


def traction(app, hist):
    """
    L1/L2. Two different growth numbers - they answer different questions:

      lifetimeRatingsPerDay = ratingCount / ageDays
          Available on the FIRST run. It is a lifetime average, so a long-dead
          app that was big years ago still scores well. Blunt, but free.

      currentRatingsPerDay  = (newest - oldest) / days between snapshots
          Needs >=2 research runs separated by >=1 day. This is the real signal.

      momentum = current / lifetime
          >1 means the app is growing FASTER than its own historical average,
          i.e. accelerating now. This is the "small app gaining traction" flag.
    """
    rc, age = app.get("ratingCount"), app.get("ageDays")
    out = {
        "lifetimeRatingsPerDay": None, "currentRatingsPerDay": None,
        "momentum": None, "observationDays": None, "snapshots": 0,
        "ratingsGained": None, "accelerating": None, "note": None,
        "provenance": "calculated",
    }
    if isinstance(rc, (int, float)) and isinstance(age, int) and age > 0:
        out["lifetimeRatingsPerDay"] = round(rc / age, 3)

    series = (hist or {}).get(str(app.get("trackId"))) or []
    out["snapshots"] = len(series)
    if len(series) < 2:
        out["note"] = ("Only one observation so far. Re-run research in a few days and "
                       "current velocity appears here.")
        return out

    (t0, rc0, _), (t1, rc1, _) = series[0], series[-1]
    days = (t1 - t0) / 86400.0
    if days < 1:
        out["note"] = f"Observation window is only {days * 24:.1f}h - too short to be meaningful."
        return out

    out["observationDays"] = round(days, 1)
    out["ratingsGained"] = rc1 - rc0
    out["currentRatingsPerDay"] = round((rc1 - rc0) / days, 3)
    if out["lifetimeRatingsPerDay"]:
        out["momentum"] = round(out["currentRatingsPerDay"] / out["lifetimeRatingsPerDay"], 2)
        out["accelerating"] = out["momentum"] > 1.2
    if days < 7:
        out["note"] = (f"Only {out['observationDays']} days of observation - treat velocity as "
                       "provisional. A week or more is much steadier.")
    return out


def traction_summary(apps, hist, riser_max=DEFAULT_RISER_MAX_RATINGS):
    """
    Keyword-level rollup. Answers the brief's requirement #3 directly:
    are SMALLER apps here actually gaining traction?
    """
    top10 = apps[:10]
    for a in top10:
        a["traction"] = traction(a, hist)

    life = [a["traction"]["lifetimeRatingsPerDay"] for a in top10
            if a["traction"]["lifetimeRatingsPerDay"] is not None]
    cur = [a["traction"]["currentRatingsPerDay"] for a in top10
           if a["traction"]["currentRatingsPerDay"] is not None]
    accel = [a for a in top10 if a["traction"].get("accelerating")]

    # The pattern actually being hunted: small apps (<500 ratings) that are
    # nonetheless picking up ratings quickly. Demand validated without a moat.
    # Judge on CURRENT velocity wherever we have it - a formerly-hot app that
    # has since gone flat has a healthy lifetime average and is not a riser.
    def best_rate(a):
        t = a["traction"]
        cur_rate = t.get("currentRatingsPerDay")
        return (cur_rate, "current") if cur_rate is not None \
            else (t.get("lifetimeRatingsPerDay"), "lifetime")

    # Every app with a measurable rate, biggest grower first, no size filter.
    # The dashboard filters this client-side so moving the threshold is instant.
    ranking = []
    for a in top10:
        rate, basis = best_rate(a)
        if rate is None:
            continue
        ranking.append({"name": a["name"], "ratingCount": a.get("ratingCount"),
                        "ratingsPerDay": rate, "basis": basis,
                        "momentum": a["traction"].get("momentum"),
                        "accelerating": a["traction"].get("accelerating")})
    ranking.sort(key=lambda r: r["ratingsPerDay"], reverse=True)

    risers = [r for r in ranking
              if isinstance(r["ratingCount"], (int, float))
              and r["ratingCount"] < riser_max and r["ratingsPerDay"] >= RISER_MIN_RATE]

    # Prefer measured current velocity over the lifetime average for the
    # download estimate too - it reflects the market now, not its whole history.
    headline_rate = statistics.median(cur) if cur else (statistics.median(life) if life else None)

    return {
        "medianLifetimeRatingsPerDay": round(statistics.median(life), 3) if life else None,
        "medianCurrentRatingsPerDay": round(statistics.median(cur), 3) if cur else None,
        "acceleratingCount": len(accel) if cur else None,
        "smallRisers": risers,
        "smallRiserCount": len(risers),
        "growthRanking": ranking,
        "riserMaxRatings": riser_max,
        "riserMinRate": RISER_MIN_RATE,
        "hasTimeSeries": bool(cur),
        "estimateBasis": "current velocity" if cur else "lifetime average",
        "estimatedDownloads": estimate_downloads(headline_rate),
        "explain": (f"smallRisers are apps under {riser_max:,} ratings gaining >={RISER_MIN_RATE} ratings/day, judged on "
                    "measured current velocity where available and lifetime average otherwise. "
                    "That is the pattern worth chasing: demand proven, no entrenched moat."),
    }


# ---------------------------------------------------------------------------
# PHASE 5 - Demand. Real signals only. No manufactured volume, ever.
# ---------------------------------------------------------------------------
def fetch_search_hints(keyword, force=False):
    """
    Apple's own App Store autocomplete. Apple only autocompletes terms people
    actually search, so PRESENCE and RANK are genuine demand evidence - but
    they are ordinal, not a volume. Returns (hints, error).
    """
    stem = keyword.strip()
    stem = stem[:-3] if len(stem) > 6 else stem[:3]
    url = "https://search.itunes.apple.com/WebObjects/MZSearchHints.woa/wa/hints?" + \
        urllib.parse.urlencode({"clientApplication": "Software", "media": "software",
                                "cc": COUNTRY, "term": stem})
    payload, err = FETCHER.get(url, headers={"X-Apple-Store-Front": STOREFRONT},
                               parse="plist", force=force)
    if err:
        return None, err

    # Defensive parse: the plist shape is not contractual. Never guess on failure.
    try:
        raw_hints = payload.get("hints") if isinstance(payload, dict) else None
        if raw_hints is None:
            return None, "Hints endpoint returned an unexpected shape."
        terms = []
        for h in raw_hints:
            term = h.get("term") if isinstance(h, dict) else (h if isinstance(h, str) else None)
            if term:
                terms.append(term)
        return {"stem": stem, "terms": terms}, None
    except Exception as exc:
        return None, f"Could not read hints payload: {exc}"


def assess_demand(keyword, hints, hints_error, comp, asa_popularity=None):
    """
    Demand as a 0-5 BAND with its provenance attached. We never output a
    search-volume number we did not receive from Apple.
    """
    kw = keyword.lower().strip()

    # Tier 1 - Apple's own Search Popularity (requires your Apple Ads credentials)
    if asa_popularity is not None:
        score = round(max(0.0, (asa_popularity - 5) / 95 * 5), 2)
        return {
            "score": score, "confidence": "HIGH", "provenance": "verified",
            "signal": f"Apple Ads Search Popularity = {asa_popularity}/100",
            "why": ("Apple's own search-popularity index for this term. This is the "
                    "single authoritative public demand signal."),
            "searchVolume": None,
            "searchVolumeNote": "Apple publishes a popularity index, not a volume. No volume exists to report.",
        }

    # Tier 2 - Apple autocomplete presence and rank
    if hints and hints.get("terms"):
        terms_l = [t.lower().strip() for t in hints["terms"]]
        rank = terms_l.index(kw) if kw in terms_l else None
        if rank is None:
            contains = [i for i, t in enumerate(terms_l) if kw in t]
            rank = contains[0] if contains else None
            exactness = "as a substring of a suggested term" if rank is not None else None
        else:
            exactness = "as an exact autocomplete suggestion"

        if rank is not None:
            score = round(max(1.2, 4.0 - 0.28 * rank), 2)   # capped below 5 on purpose
            return {
                "score": score, "confidence": "MEDIUM", "provenance": "proxy",
                "signal": f"Apple autocomplete rank #{rank + 1} of {len(terms_l)} for stem '{hints['stem']}'",
                "why": ("Apple only autocompletes queries real users type, so presence is genuine "
                        "demand evidence. Rank is ordinal - it tells us relative popularity, not "
                        f"how many searches. Matched {exactness}. Capped at 4.0/5 because no "
                        "volume figure backs it."),
                "searchVolume": None,
                "searchVolumeNote": "UNAVAILABLE without a paid ASO provider or Apple Ads credentials.",
            }

        return {
            "score": 1.0, "confidence": "LOW", "provenance": "proxy",
            "signal": f"Absent from Apple autocomplete for stem '{hints['stem']}'",
            "why": ("Apple returned suggestions for this stem but none matched your keyword. "
                    "That is weak evidence of low search demand - not proof, since autocomplete "
                    "lists are short and head-weighted."),
            "searchVolume": None,
            "searchVolumeNote": "UNAVAILABLE without a paid ASO provider or Apple Ads credentials.",
        }

    # Tier 3 - supply-side proxy: developers optimising for a term implies belief in demand
    if comp and comp.get("exactInTitle") is not None:
        targeting = comp["exactInTitle"] + 0.5 * comp["inTitle"]
        if targeting >= 2:
            score = round(min(2.5, 0.8 + 0.25 * targeting), 2)
            return {
                "score": score, "confidence": "LOW", "provenance": "proxy",
                "signal": f"{comp['exactInTitle']} exact + {comp['inTitle']} partial title matches in top 10",
                "why": ("Autocomplete data unavailable, so this is inferred from SUPPLY, not demand: "
                        "developers put a term in their title when they believe people search it. "
                        "Capped at 2.5/5 - it is an inference about competitors' beliefs."),
                "searchVolume": None,
                "searchVolumeNote": "UNAVAILABLE without a paid ASO provider or Apple Ads credentials.",
            }

    return {
        "score": None, "confidence": "UNKNOWN", "provenance": "unavailable",
        "signal": hints_error or "No demand signal obtained.",
        "why": ("No legitimate demand signal was available for this keyword. The opportunity "
                "score is withheld rather than guessed."),
        "searchVolume": None,
        "searchVolumeNote": "UNAVAILABLE without a paid ASO provider or Apple Ads credentials.",
    }


# ---------------------------------------------------------------------------
# PHASE 6 - Opportunity model. Components stay visible; nothing is hidden.
# ---------------------------------------------------------------------------
def rank_evidence(comp):
    """
    EVIDENCE SMALLER APPS CAN RANK  (0-1). Replaces the old "beatability".

    Two observed quantities, no pass/fail thresholds, no penalty for the mere
    existence of a large competitor:

      entryFactor  - how low is the FLOOR of the top 10?
                     Built on the 25th percentile of rating counts, not the
                     median. You do not need to match the median to appear; you
                     need to clear the bar the weakest ranked apps cleared.
                       1 - log10(entryBarP25 + 1) / log10(50000)

      reachFactor  - how HIGH can a below-median app get?
                     If below-median apps reach #2-#4, size is not gating rank.
                     If they only appear at #9-#10, the SERP is stratified.
                       1 - (bestPositionBelowMedian - 1) / sampleSize

    rankEvidence = entryFactor * reachFactor

    A dominant incumbent does NOT reduce this. A 50,000-rating app at #1 with
    95-, 180- and 420-rating apps at #4-#6 is strong evidence that small apps
    rank here - which is the opposite of a reason to walk away.

    Rating count is a proxy for competitor TRACTION only. It is not keyword
    difficulty, not downloads, not search demand.
    """
    pen = comp.get("penetration") if comp else None
    if not pen:
        return None

    entry = 1 - (math.log10(pen["entryBarP25"] + 1) / math.log10(50000))
    entry = max(0.03, min(entry, 1.0))

    best = pen.get("bestPositionBelowMedian")
    n = max(pen.get("sampleSize") or 10, 1)
    reach = 1.0 if best is None else max(0.15, 1 - (best - 1) / n)

    value = entry * reach
    return {
        "value": round(value, 4),
        "components": {"entryFactor": round(entry, 3), "reachFactor": round(reach, 3)},
        "entryBarP25": pen["entryBarP25"],
        "entryBarMin": pen["entryBarMin"],
        "bestPositionBelowMedian": best,
        "explain": (f"The weakest ranked apps sit around {pen['entryBarP25']:,.0f} ratings "
                    f"(lowest on the page: {pen['entryBarMin']:,.0f})"
                    + (f", and a below-median app reaches #{best}." if best
                       else ", and no app sits below the field median.")),
        "dominantIncumbentImpact": "none - large competitors do not reduce this score",
        "provenance": "calculated",
    }


def listing_weakness(apps):
    """
    PRODUCT / LISTING WEAKNESS across the top 10. Weak incumbent listings make a
    space easier to enter, so this MODIFIES the opportunity rather than gating it.
    Deliberately a narrow band (0.85-1.25): it tilts, it cannot collapse a score.
    """
    top10 = apps[:10]
    if not top10:
        return None
    flags = [len(product_signals(a)["weaknessFlags"]) for a in top10]
    weak_share = sum(1 for f in flags if f) / len(flags)
    modifier = 0.85 + 0.4 * weak_share
    return {
        "appsWithWeakness": sum(1 for f in flags if f),
        "sampleSize": len(flags),
        "weakShare": round(weak_share, 2),
        "avgFlagsPerApp": round(statistics.mean(flags), 2),
        "modifier": round(modifier, 3),
        "formula": "0.85 + 0.4 * (share of top 10 with >=1 listing weakness)",
        "provenance": "calculated",
    }


def opportunity(demand, comp, product_fit, commercial_intent, apps=None):
    """
    OPPORTUNITY = 100 * [ DEMAND x RANK EVIDENCE x PRODUCT FIT x COMMERCIAL INTENT ]
                        x listingWeaknessModifier

    Four gates, multiplied, because each can independently kill a candidate:
      * no demand           -> nothing to win
      * small apps can't rank -> you cannot get in
      * poor product fit    -> not your market
      * no commercial intent -> cannot monetise it

    Listing weakness is a MODIFIER (0.85-1.25), not a gate: weak incumbent
    listings make entry easier but their absence does not disqualify a keyword.

    Competitor strength is NOT a separate factor here - it would double-count,
    since entry bar and reach already express it. It is reported alongside as
    descriptive context.

    Withheld whenever demand or SERP distribution is unknown. Gaps are never filled.
    """
    ev = rank_evidence(comp) if comp else None
    if demand.get("score") is None or ev is None:
        return {
            "score": None,
            "reason": "Withheld: " + ("no demand signal." if demand.get("score") is None
                                      else "no usable SERP rating distribution."),
            "factors": None,
        }

    weak = listing_weakness(apps) if apps else None
    factors = {
        "demand": {"raw": demand["score"], "norm": demand["score"] / 5,
                   "kind": "objective", "role": "gate", "note": demand.get("signal")},
        "smallAppsCanRank": {"raw": round(ev["value"] * 5, 2), "norm": ev["value"],
                             "kind": "objective", "role": "gate", "note": ev["explain"],
                             "components": ev["components"]},
        "productFit": {"raw": product_fit, "norm": (product_fit or 0) / 5,
                       "kind": "subjective", "role": "gate", "note": "Your rating."},
        "commercialIntent": {"raw": commercial_intent, "norm": (commercial_intent or 0) / 5,
                             "kind": "subjective", "role": "gate", "note": "Your rating."},
    }
    if weak:
        factors["listingWeakness"] = {
            "raw": f"{weak['appsWithWeakness']}/{weak['sampleSize']} weak listings",
            "norm": weak["modifier"], "kind": "objective", "role": "modifier",
            "note": weak["formula"],
        }

    if product_fit is None or commercial_intent is None:
        return {
            "score": None,
            "reason": "Withheld: rate PRODUCT FIT and COMMERCIAL INTENT (1-5) to compute.",
            "factors": factors,
        }

    core = 1.0
    for key in ("demand", "smallAppsCanRank", "productFit", "commercialIntent"):
        core *= max(factors[key]["norm"], 0.0)
    modifier = weak["modifier"] if weak else 1.0
    score = round(min(core * modifier, 1.0) * 100)

    band = "STRONG" if score >= 30 else ("WORTH A LOOK" if score >= 15 else "WEAK")
    gated = None
    if band == "STRONG" and demand["confidence"] in ("LOW", "UNKNOWN"):
        band, gated = "WORTH A LOOK", ("Capped below STRONG: demand confidence is "
                                       f"{demand['confidence']}. Get a real demand signal first.")

    return {
        "score": score,
        "band": band,
        "bandGate": gated,
        "factors": factors,
        "confidence": demand["confidence"],
        "listingWeakness": weak,
        "competitorStrengthContext": (comp.get("strength") or {}).get("score"),
        "formula": ("100 * demand * smallAppsCanRank * productFit * commercialIntent "
                    "* listingWeaknessModifier"),
        "caveat": ("Two of four gates are your own subjective ratings. The score RANKS "
                   "candidates - it measures nothing. Read the Top-10 distribution below "
                   "before trusting it."),
    }


# ---------------------------------------------------------------------------
# PHASE 4 - Product quality (objective listing signals only)
# ---------------------------------------------------------------------------
def product_signals(app):
    """
    Observable listing-quality signals. We deliberately do NOT score 'visual
    quality' or 'sophistication' - those need human eyes, so we surface the
    screenshots and let you judge in five seconds.
    """
    out = {"observable": {}, "requiresYourEyes": [
        "Visual / screenshot quality", "Positioning clarity",
        "Apparent product sophistication", "Differentiation",
    ]}
    o = out["observable"]
    o["screenshotCount"] = app.get("screenshotCount")
    o["hasIpadScreenshots"] = bool(app.get("ipadScreenshotCount"))
    o["descriptionLength"] = app.get("descriptionLength")
    o["daysSinceUpdate"] = app.get("daysSinceUpdate")
    o["ageDays"] = app.get("ageDays")
    o["localisations"] = app.get("languageCount")
    o["pricing"] = app.get("formattedPrice")

    flags = []
    dsu = app.get("daysSinceUpdate")
    if isinstance(dsu, int):
        if dsu > 365:
            flags.append("Abandoned-looking: no update in over a year")
        elif dsu > 180:
            flags.append("Slow cadence: no update in 6+ months")
    if isinstance(app.get("screenshotCount"), int) and app["screenshotCount"] <= 3:
        flags.append("Thin screenshot set (<=3) - weak store presentation")
    if isinstance(app.get("descriptionLength"), int) and app["descriptionLength"] < 600:
        flags.append("Very short description - listing likely unoptimised")
    if isinstance(app.get("rating"), (int, float)) and app["rating"] < 4.0:
        flags.append(f"Weak rating ({app['rating']}) - user dissatisfaction")
    rc, age = app.get("ratingCount"), app.get("ageDays")
    if isinstance(rc, int) and isinstance(age, int) and age > 730 and rc < 200:
        flags.append("Low traction for its age - years old, still few ratings")
    out["weaknessFlags"] = flags
    out["weaknessCount"] = len(flags)
    return out


# Transparent lexical buckets. This is string matching, NOT AI analysis.
REVIEW_THEMES = {
    "SUBSCRIPTION / PRICING COMPLAINTS": [
        "subscription", "expensive", "paywall", "refund", "free trial", "charged",
        "cancel", "per month", "rip off", "ripoff", "overpriced", "pay wall",
        "money", "price", "not free", "scam",
    ],
    "COMMON COMPLAINTS": [
        "crash", "bug", "buggy", "freeze", "froze", "glitch", "broken", "doesn't work",
        "does not work", "won't load", "error", "stuck", "useless", "disappointed",
        "repetitive", "generic", "boring", "annoying", "laggy",
    ],
    "COMMON REQUESTS": [
        "wish", "would love", "please add", "hope you add", "feature request",
        "needs a", "should have", "would be nice", "suggestion", "please make",
    ],
    "MISSING FEATURES": [
        "offline", "download", "apple watch", "widget", "dark mode", "timer",
        "customize", "customise", "custom", "alarm", "reminder", "ipad",
        "sync", "export", "no way to", "can't add", "cannot add",
    ],
    "WHAT USERS LOVE": [
        "love", "amazing", "helped", "life changing", "life-changing", "best",
        "perfect", "grateful", "excellent", "wonderful", "obsessed", "favorite",
        "favourite", "game changer",
    ],
}


def fetch_reviews(track_id, pages=3, force=False):
    """Apple's public customer-reviews RSS. ~50 reviews/page, 10 pages max."""
    reviews, errors = [], []
    for page in range(1, max(1, min(pages, 10)) + 1):
        url = (f"https://itunes.apple.com/{COUNTRY}/rss/customerreviews/page={page}"
               f"/id={track_id}/sortby=mostrecent/json")
        payload, err = FETCHER.get(url, force=force)
        if err:
            errors.append(err)
            break
        entries = (payload.get("feed") or {}).get("entry") or []
        if isinstance(entries, dict):
            entries = [entries]
        for e in entries:
            if not isinstance(e, dict) or "im:rating" not in e:
                continue   # first entry is the app itself, not a review
            reviews.append({
                "title": (e.get("title") or {}).get("label"),
                "body": (e.get("content") or {}).get("label"),
                "rating": int((e.get("im:rating") or {}).get("label") or 0),
                "version": (e.get("im:version") or {}).get("label"),
                "author": ((e.get("author") or {}).get("name") or {}).get("label"),
            })
        if len(entries) < 2:
            break
    return reviews, errors


def mine_reviews(reviews):
    """Bucket reviews by literal keyword match. Transparent and auditable."""
    buckets = {k: [] for k in REVIEW_THEMES}
    for r in reviews:
        text = f"{r.get('title') or ''} {r.get('body') or ''}".lower()
        for theme, needles in REVIEW_THEMES.items():
            hit = next((n for n in needles if n in text), None)
            if hit:
                buckets[theme].append({
                    "matched": hit, "rating": r["rating"],
                    "title": r.get("title"),
                    "excerpt": (r.get("body") or "")[:320],
                })
    ratings = [r["rating"] for r in reviews if r.get("rating")]
    return {
        "method": ("Literal keyword matching against fixed word lists - NOT AI analysis and "
                   "NOT sentiment analysis. Every match shows the exact word that triggered it. "
                   "Use the raw review export for real qualitative work."),
        "reviewsAnalysed": len(reviews),
        "ratingBreakdown": {str(s): sum(1 for r in ratings if r == s) for s in range(1, 6)} if ratings else None,
        "negativeShare": (round(100 * sum(1 for r in ratings if r <= 2) / len(ratings))
                          if ratings else None),
        "themes": {k: {"count": len(v), "samples": v[:8]} for k, v in buckets.items()},
        "coverageCaveat": ("Apple's public feed serves only the ~500 most recent US reviews. "
                           "This is a recency-biased sample, not the full review history."),
    }


# ---------------------------------------------------------------------------
# Apple Ads Search Popularity - built, disabled until you supply credentials
# ---------------------------------------------------------------------------
ASA_CRED_PATH = os.path.join(ROOT, "asa_credentials.json")
ASA_SETUP = {
    "status": "NOT CONFIGURED",
    "whatItUnlocks": ("Apple's official Search Popularity index (1-100) per keyword. This is the "
                      "only signal that raises demand confidence to HIGH."),
    "whatYouNeed": [
        "An active Apple Ads (Search Ads) account - Indie plan or higher.",
        "Apple Ads -> Account Settings -> API -> upload a public key / create API access.",
        "Apple then shows you three values: clientId, teamId, keyId.",
        "Keep the matching ES256 private key as a .pem file on this machine.",
    ],
    "howToEnable": (f"Create {os.path.basename(ASA_CRED_PATH)} next to scout.py containing: "
                    '{"clientId": "SEARCHADS.xxxx", "teamId": "SEARCHADS.xxxx", '
                    '"keyId": "xxxx", "privateKeyPath": "/abs/path/key.pem"}'),
    "security": "The private key never leaves this machine and is never sent anywhere but Apple.",
    "endpoint": "POST https://api.ads.apple.com/api/v1/insights/apps/search-term-popularity/query",
    "note": ("Signing the client-secret JWT needs ES256. Python's stdlib cannot do that, so "
             "enabling this requires one dependency: `pip install pyjwt[crypto]`. Until then the "
             "tool runs fully on stdlib and demand tops out at MEDIUM confidence."),
}


def asa_status():
    if not os.path.exists(ASA_CRED_PATH):
        return dict(ASA_SETUP)
    try:
        with open(ASA_CRED_PATH) as fh:
            creds = json.load(fh)
        missing = [k for k in ("clientId", "teamId", "keyId", "privateKeyPath") if not creds.get(k)]
        st = dict(ASA_SETUP)
        if missing:
            st["status"] = f"INCOMPLETE - missing: {', '.join(missing)}"
            return st
        try:
            import jwt  # noqa: F401
        except ImportError:
            st["status"] = "CREDENTIALS FOUND - but PyJWT is not installed. Run: pip install 'pyjwt[crypto]'"
            return st
        st["status"] = "CONFIGURED"
        return st
    except Exception as exc:
        st = dict(ASA_SETUP)
        st["status"] = f"ERROR reading credentials: {exc}"
        return st


def fetch_asa_popularity(keywords):
    """Returns {keyword: popularity} or {} when not configured. Never fabricates."""
    st = asa_status()
    if st["status"] != "CONFIGURED":
        return {}, st["status"]
    try:
        import jwt
        with open(ASA_CRED_PATH) as fh:
            c = json.load(fh)
        with open(c["privateKeyPath"]) as fh:
            private_key = fh.read()
        issued = int(time.time())
        secret = jwt.encode(
            {"sub": c["clientId"], "aud": "https://appleid.apple.com",
             "iat": issued, "exp": issued + 1200, "iss": c["teamId"]},
            private_key, algorithm="ES256", headers={"alg": "ES256", "kid": c["keyId"]})
        body = urllib.parse.urlencode({
            "grant_type": "client_credentials", "client_id": c["clientId"],
            "client_secret": secret, "scope": "searchadsorg"}).encode()
        req = urllib.request.Request(
            "https://appleid.apple.com/auth/oauth2/token", data=body,
            headers={"Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=30) as resp:
            token = json.loads(resp.read())["access_token"]

        payload = json.dumps({
            "selector": {"conditions": [{"field": "searchTerm", "operator": "IN", "values": keywords}],
                         "pagination": {"offset": 0, "limit": 1000}},
            "countryOrRegion": COUNTRY.upper(),
        }).encode()
        req = urllib.request.Request(
            "https://api.ads.apple.com/api/v1/insights/apps/search-term-popularity/query",
            data=payload, headers={"Authorization": f"Bearer {token}",
                                   "Content-Type": "application/json", "User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=45) as resp:
            data = json.loads(resp.read())
        out = {}
        for row in (data.get("data") or {}).get("results", data.get("data") or []):
            if isinstance(row, dict):
                term = row.get("searchTerm") or row.get("keyword")
                pop = row.get("searchPopularity1to100") or row.get("searchPopularity")
                if term and pop is not None:
                    out[str(term).lower().strip()] = pop
        return out, "CONFIGURED"
    except Exception as exc:
        return {}, f"Apple Ads call failed: {type(exc).__name__}: {exc}"


# ---------------------------------------------------------------------------
# Session state
# ---------------------------------------------------------------------------
class Session:
    def __init__(self, name="default"):
        self.lock = threading.Lock()
        self.name = name
        self.keywords = {}     # keyword -> {productFit, commercialIntent, notes}
        self.results = {}      # keyword -> research payload
        if not self.load(name):
            for kw in SEED_KEYWORDS:
                self.keywords[kw] = {"productFit": None, "commercialIntent": None, "notes": ""}
            self.save()

    def path(self, name=None):
        return os.path.join(SESSION_DIR, f"{slug(name or self.name)}.json")

    def save(self, name=None):
        with self.lock:
            target = self.path(name)
            with open(target, "w") as fh:
                json.dump({"name": name or self.name, "savedAt": now_iso(),
                           "market": COUNTRY, "store": "Apple App Store / iPhone",
                           "keywords": self.keywords, "results": self.results}, fh, indent=1)
        return target

    def load(self, name):
        p = self.path(name)
        if not os.path.exists(p):
            return False
        try:
            with open(p) as fh:
                blob = json.load(fh)
            with self.lock:
                self.name = blob.get("name", name)
                self.keywords = blob.get("keywords", {})
                self.results = blob.get("results", {})
            return True
        except Exception:
            return False

    def add(self, keyword):
        kw = " ".join(keyword.lower().split())
        if kw and kw not in self.keywords:
            self.keywords[kw] = {"productFit": None, "commercialIntent": None, "notes": ""}
            return True
        return False

    def remove(self, keyword):
        self.keywords.pop(keyword, None)
        self.results.pop(keyword, None)

    def rate(self, keyword, field, value):
        if keyword in self.keywords and field in ("productFit", "commercialIntent", "notes"):
            self.keywords[keyword][field] = value

    def row(self, kw):
        """One flat row for the main table."""
        meta = self.keywords.get(kw, {})
        res = self.results.get(kw)
        fit, intent = meta.get("productFit"), meta.get("commercialIntent")
        if not res:
            return {"keyword": kw, "researched": False, "productFit": fit,
                    "commercialIntent": intent, "demand": None, "demandConfidence": "UNKNOWN",
                    "competition": None, "competitionBand": None, "medianTop10Ratings": None,
                    "top10Under500": None, "dominant": None, "opportunity": None,
                    "opportunityBand": None, "tractionPerDay": None, "smallRisers": None,
                    "accelerating": None, "riserPairs": [], "ladder": [], "entryBar": None,
                    "entryBarMin": None, "bestPosSmall": None, "bestPosUnder1000": None,
                    "under100": None, "under1000": None, "over10000": None,
                    "avgRatingCount": None, "rankEvidence": None, "error": None}
        comp, dem = res.get("competition") or {}, res.get("demand") or {}
        trac = res.get("traction") or {}
        opp = opportunity(dem, comp, fit, intent, res.get("apps"))
        strength = comp.get("strength") or {}
        pen = comp.get("penetration") or {}
        dom = comp.get("dominantIncumbent")
        return {
            "keyword": kw, "researched": True,
            "demand": dem.get("score"), "demandConfidence": dem.get("confidence", "UNKNOWN"),
            "demandSignal": dem.get("signal"),
            "competition": strength.get("score"), "competitionBand": strength.get("band"),
            "medianTop10Ratings": comp.get("medianRatingCount"),
            "top10Under500": comp.get("under500"), "pctUnder500": comp.get("pctUnder500"),
            "dominant": (f"{dom['name']} ({dom['ratingCount']:,})" if dom else None),
            "avgStars": comp.get("avgStars"), "appCount": len(res.get("apps") or []),
            "ladder": [x["ratingCount"] for x in (pen.get("ladder") or [])],
            "entryBar": pen.get("entryBarP25"),
            "entryBarMin": pen.get("entryBarMin"),
            "bestPosSmall": pen.get("bestPositionBelowMedian"),
            "bestPosUnder1000": pen.get("bestPositionUnder1000"),
            "under100": comp.get("under100"), "under1000": comp.get("under1000"),
            "over10000": comp.get("over10000"), "avgRatingCount": comp.get("avgRatingCount"),
            "rankEvidence": (rank_evidence(comp) or {}).get("value"),
            "tractionPerDay": (trac.get("medianCurrentRatingsPerDay")
                               if trac.get("hasTimeSeries")
                               else trac.get("medianLifetimeRatingsPerDay")),
            "tractionBasis": trac.get("estimateBasis"),
            "smallRisers": trac.get("smallRiserCount"),
            "riserPairs": [[r["ratingCount"], r["ratingsPerDay"]]
                           for r in (trac.get("growthRanking") or [])
                           if isinstance(r["ratingCount"], (int, float))],
            "accelerating": trac.get("acceleratingCount"),
            "productFit": fit, "commercialIntent": intent,
            "opportunity": opp.get("score"), "opportunityBand": opp.get("band"),
            "opportunityReason": opp.get("reason"),
            "fetchedAt": (res.get("meta") or {}).get("fetchedAt"),
            "error": res.get("error"),
        }


SESSION = Session()

PROGRESS = {"running": False, "done": 0, "total": 0, "current": "", "log": [], "finishedAt": None}


def run_research(keywords, force=False):
    """Phases 2+3+5 for each keyword. Sequential - respects Apple's rate limit."""
    global PROGRESS
    PROGRESS.update({"running": True, "done": 0, "total": len(keywords),
                     "current": "", "log": [], "finishedAt": None})

    asa_map, asa_msg = fetch_asa_popularity(keywords)
    if asa_map:
        PROGRESS["log"].append(f"Apple Ads popularity loaded for {len(asa_map)} keywords.")
    else:
        PROGRESS["log"].append(f"Apple Ads popularity unavailable ({asa_msg}). "
                               "Demand confidence will top out at MEDIUM.")

    for kw in keywords:
        PROGRESS["current"] = kw
        try:
            apps, meta, err = fetch_serp(kw, force=force)
            if err:
                SESSION.results[kw] = {"error": err, "apps": [], "meta": {},
                                       "competition": {}, "demand": {}}
                PROGRESS["log"].append(f"[{kw}] SERP failed: {err}")
            else:
                comp = analyse_competition(apps, kw)
                hist = record_snapshots(apps)
                save_history(hist)
                trac = traction_summary(apps, hist)
                hints, herr = fetch_search_hints(kw, force=force)
                if herr:
                    PROGRESS["log"].append(f"[{kw}] autocomplete unavailable: {herr}")
                dem = assess_demand(kw, hints, herr, comp, asa_map.get(kw.lower().strip()))
                SESSION.results[kw] = {
                    "apps": apps, "meta": meta, "competition": comp, "demand": dem,
                    "traction": trac, "hints": hints, "error": None,
                    "relatedTerms": (hints or {}).get("terms"),
                }
                PROGRESS["log"].append(
                    f"[{kw}] {len(apps)} apps | competition {comp.get('strength', {}).get('score', '-')} "
                    f"| demand {dem.get('confidence')}")
        except Exception as exc:
            SESSION.results[kw] = {"error": f"{type(exc).__name__}: {exc}", "apps": [],
                                   "meta": {}, "competition": {}, "demand": {}}
            PROGRESS["log"].append(f"[{kw}] crashed: {exc}")
        PROGRESS["done"] += 1

    SESSION.save()
    PROGRESS.update({"running": False, "current": "", "finishedAt": now_iso()})


# ---------------------------------------------------------------------------
# Exports
# ---------------------------------------------------------------------------
CSV_COLUMNS = [
    ("keyword", "KEYWORD"), ("demand", "DEMAND_0_5"), ("demandConfidence", "DEMAND_CONFIDENCE"),
    ("demandSignal", "DEMAND_SIGNAL"), ("competition", "COMPETITOR_STRENGTH_0_100"),
    ("competitionBand", "COMPETITION_BAND"), ("medianTop10Ratings", "MEDIAN_TOP10_RATINGS"),
    ("top10Under500", "TOP10_UNDER_500"), ("pctUnder500", "PCT_UNDER_500"),
    ("avgStars", "AVG_STARS"), ("dominant", "DOMINANT_COMPETITOR"),
    ("productFit", "PRODUCT_FIT_1_5"), ("commercialIntent", "COMMERCIAL_INTENT_1_5"),
    ("tractionPerDay", "MEDIAN_TOP10_RATINGS_PER_DAY_OBSERVED"),
    ("smallRisers", "SMALL_APPS_GAINING_TRACTION"),
    ("accelerating", "TOP10_ACCELERATING_NOW"),
    ("opportunity", "OPPORTUNITY_0_100"), ("opportunityBand", "OPPORTUNITY_BAND"),
    ("fetchedAt", "FETCHED_AT"),
]


def export_csv():
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow([h for _, h in CSV_COLUMNS])
    w.writerow(["# search volume, keyword difficulty, downloads and revenue are UNAVAILABLE "
                "(paid providers only) and are deliberately absent from this export"]
               + [""] * (len(CSV_COLUMNS) - 1))
    for kw in SESSION.keywords:
        row = SESSION.row(kw)
        cells = []
        for key, _ in CSV_COLUMNS:
            val = row.get(key)
            if val is not None:
                cells.append(val)
            elif key == "dominant" and row.get("researched"):
                # Absence of a dominant incumbent is a finding, not missing data.
                cells.append("NONE DETECTED")
            elif not row.get("researched"):
                cells.append("NOT RESEARCHED")
            else:
                cells.append("UNAVAILABLE")
        w.writerow(cells)
    return buf.getvalue()


def export_json():
    return json.dumps({
        "tool": "App Opportunity Scout",
        "exportedAt": now_iso(),
        "market": COUNTRY, "store": "Apple App Store / iPhone",
        "sources": {
            "serp": "iTunes Search API (public, unauthenticated)",
            "reviews": "Apple customer reviews RSS (public, ~500 most recent US reviews)",
            "demand": "Apple autocomplete hints + optional Apple Ads Search Popularity",
        },
        "unavailableMetrics": ["keyword search volume", "keyword difficulty",
                               "revenue (needs unobservable free-to-paid conversion)",
                               "true App Store SERP rank"],
        "modelledMetrics": {
            "ratingVelocity": "OBSERVED - Apple rating counts sampled across research runs.",
            "downloads": ("ESTIMATED RANGE ONLY - ratings/day divided by an assumed or "
                          "calibrated rating rate. Order of magnitude, not a measurement."),
        },
        "ratingRateInForce": {"band": rating_rate_band()[0], "source": rating_rate_band()[1],
                              "calibrationPairs": rating_rate_band()[2]},
        "provenanceLegend": PROVENANCE,
        "session": SESSION.name,
        "keywords": SESSION.keywords,
        "rows": [SESSION.row(kw) for kw in SESSION.keywords],
        "results": SESSION.results,
    }, indent=1)


# ---------------------------------------------------------------------------
# Local web server
# ---------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # keep the terminal quiet

    def _send(self, code, body, ctype="application/json", extra=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj))

    def _body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            return {}

    # -- GET ---------------------------------------------------------------
    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        route, qs = url.path, urllib.parse.parse_qs(url.query)

        if route in ("/", "/index.html"):
            try:
                with open(os.path.join(ROOT, "dashboard.html"), "rb") as fh:
                    return self._send(200, fh.read(), "text/html; charset=utf-8")
            except FileNotFoundError:
                return self._send(500, "dashboard.html is missing", "text/plain")

        if route == "/api/state":
            return self._json({
                "session": SESSION.name,
                "market": COUNTRY, "store": "Apple App Store / iPhone",
                "keywords": SESSION.keywords,
                "rows": [SESSION.row(kw) for kw in SESSION.keywords],
                "progress": PROGRESS,
                "asa": asa_status(),
                "provenance": PROVENANCE,
                "liveCalls": FETCHER.live_calls,
                "sessions": sorted(f[:-5] for f in os.listdir(SESSION_DIR) if f.endswith(".json")),
            })

        if route == "/api/progress":
            return self._json(PROGRESS)

        if route == "/api/keyword":
            kw = (qs.get("kw") or [""])[0]
            res = SESSION.results.get(kw)
            if not res:
                return self._json({"error": "Not researched yet."}, 404)
            apps = res.get("apps") or []
            meta = SESSION.keywords.get(kw, {})
            return self._json({
                "keyword": kw,
                "meta": res.get("meta"),
                "demand": res.get("demand"),
                "competition": res.get("competition"),
                "traction": res.get("traction"),
                "ratingRate": {"band": rating_rate_band()[0], "source": rating_rate_band()[1],
                               "pairs": rating_rate_band()[2]},
                "apps": [dict(a, productSignals=product_signals(a)) for a in apps],
                "relatedTerms": res.get("relatedTerms"),
                "opportunity": opportunity(res.get("demand") or {}, res.get("competition") or {},
                                           meta.get("productFit"), meta.get("commercialIntent"),
                                           res.get("apps")),
                "ratings": meta,
                "reviews": res.get("reviews"),
                "error": res.get("error"),
            })

        if route == "/api/export.csv":
            return self._send(200, export_csv(), "text/csv",
                              {"Content-Disposition": "attachment; filename=app-opportunity-scout.csv"})

        if route == "/api/export.json":
            return self._send(200, export_json(), "application/json",
                              {"Content-Disposition": "attachment; filename=app-opportunity-scout.json"})

        return self._json({"error": "Unknown route"}, 404)

    # -- POST --------------------------------------------------------------
    def do_POST(self):
        route = urllib.parse.urlparse(self.path).path
        body = self._body()

        if route == "/api/keywords/add":
            added = [k for k in (body.get("keywords") or []) if SESSION.add(k)]
            SESSION.save()
            return self._json({"added": added})

        if route == "/api/keywords/remove":
            for k in (body.get("keywords") or []):
                SESSION.remove(k)
            SESSION.save()
            return self._json({"ok": True})

        if route == "/api/rate":
            SESSION.rate(body.get("keyword"), body.get("field"), body.get("value"))
            SESSION.save()
            return self._json({"row": SESSION.row(body.get("keyword"))})

        if route == "/api/research":
            if PROGRESS["running"]:
                return self._json({"error": "A research run is already in progress."}, 409)
            kws = body.get("keywords") or list(SESSION.keywords)
            kws = [k for k in kws if k in SESSION.keywords]
            if not kws:
                return self._json({"error": "No keywords to research."}, 400)
            threading.Thread(target=run_research, args=(kws, bool(body.get("force"))),
                             daemon=True).start()
            return self._json({"started": len(kws),
                               "estimatedSeconds": round(len(kws) * REQUEST_SPACING * 2)})

        if route == "/api/reviews":
            kw, track_id = body.get("keyword"), body.get("trackId")
            res = SESSION.results.get(kw)
            if not res:
                return self._json({"error": "Keyword not researched yet."}, 404)
            reviews, errors = fetch_reviews(track_id, pages=int(body.get("pages") or 3))
            if not reviews:
                return self._json({"error": "No reviews returned. "
                                   + (errors[0] if errors else "This app may have no US reviews.")}, 404)
            analysis = mine_reviews(reviews)
            res.setdefault("reviews", {})[str(track_id)] = analysis
            SESSION.save()
            return self._json({"analysis": analysis, "raw": reviews, "errors": errors})

        if route == "/api/session/save":
            name = body.get("name") or SESSION.name
            path = SESSION.save(name)
            return self._json({"saved": os.path.basename(path)})

        if route == "/api/session/load":
            name = body.get("name")
            if not SESSION.load(name):
                return self._json({"error": f"No session named '{name}'."}, 404)
            return self._json({"loaded": SESSION.name})

        return self._json({"error": "Unknown route"}, 404)


def main():
    port = 8787
    if "--port" in sys.argv:
        try:
            port = int(sys.argv[sys.argv.index("--port") + 1])
        except Exception:
            pass

    print("\n  APP OPPORTUNITY SCOUT")
    print("  " + "-" * 52)
    print(f"  Market        : United States / Apple App Store (iPhone)")
    print(f"  Keywords      : {len(SESSION.keywords)} in session '{SESSION.name}'")
    print(f"  Apple Ads     : {asa_status()['status']}")
    print(f"  Rate limit    : 1 request / {REQUEST_SPACING}s (Apple allows ~20/min)")
    print(f"  Cache         : {CACHE_TTL // 86400} days, in ./cache")
    print("  " + "-" * 52)
    print(f"  Open  ->  http://localhost:{port}\n")
    print("  Ctrl-C to stop.\n")
    try:
        ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped. Session saved.\n")


if __name__ == "__main__":
    main()
