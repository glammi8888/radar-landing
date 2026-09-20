#!/usr/bin/env python3
"""
Offline self-test: runs the whole pipeline against a fixture that mimics a real
iTunes Search API payload, with no network. Verifies parsing, metrics, the
scoring behaviour the brief specifies, and that missing data stays missing.

    python3 selftest.py
"""
import json
import sys

import scout

FAILS = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   {detail}" if detail and not cond else ""))
    if not cond:
        FAILS.append(label)


def itunes_record(i, name, rc, stars, price=0.0, shots=5, desc=1500,
                  release="2021-03-04T07:00:00Z", updated="2026-06-01T07:00:00Z"):
    """Shaped like a real iTunes Search API 'software' record."""
    return {
        "trackId": 1000000 + i, "trackName": name, "sellerName": f"{name} Labs",
        "artistName": f"{name} Labs", "primaryGenreName": "Health & Fitness",
        "genres": ["Health & Fitness", "Lifestyle"], "userRatingCount": rc,
        "averageUserRating": stars, "averageUserRatingForCurrentVersion": stars,
        "userRatingCountForCurrentVersion": rc // 3, "price": price,
        "formattedPrice": "Free" if price == 0 else f"${price}", "currency": "USD",
        "version": "3.2.1", "releaseDate": release, "currentVersionReleaseDate": updated,
        "description": "Visualize your future self. " * (desc // 27),
        "releaseNotes": "Bug fixes.", "artworkUrl512": "https://example.invalid/icon.png",
        "screenshotUrls": [f"https://example.invalid/s{n}.png" for n in range(shots)],
        "ipadScreenshotUrls": [], "minimumOsVersion": "15.0",
        "trackViewUrl": f"https://apps.apple.com/us/app/id{1000000+i}",
        "trackContentRating": "4+", "fileSizeBytes": "88000000",
        "languageCodesISO2A": ["EN"], "bundleId": f"com.example.app{i}",
        "wrapperType": "software", "kind": "software",
    }


def run():
    print("\nAPP OPPORTUNITY SCOUT - offline self-test\n" + "=" * 52)

    # --- 1. Parsing a realistic record --------------------------------------
    print("\n[1] iTunes Search API record parsing")
    a = scout.normalise_app(itunes_record(1, "Visualize Daily", 342, 4.7), 1, "visualization")
    check("name parsed", a["name"] == "Visualize Daily")
    check("developer parsed", a["developer"] == "Visualize Daily Labs")
    check("rating count parsed", a["ratingCount"] == 342)
    check("price -> isFree", a["isFree"] is True)
    check("app age calculated", isinstance(a["ageDays"], int) and a["ageDays"] > 1000)
    check("days since update calculated", isinstance(a["daysSinceUpdate"], int))
    check("partial title match detected", a["partialMatchInTitle"] is False)  # 'visualization' != 'visualize'
    check("subtitle stays None (not in this API)", a["subtitle"] is None)
    check("downloads stays None (paid providers only)", a["downloads"] is None)
    check("revenue stays None (paid providers only)", a["revenue"] is None)

    exact = scout.normalise_app(itunes_record(2, "Guided Visualization Pro", 120, 4.5),
                                2, "guided visualization")
    check("exact title match detected", exact["exactMatchInTitle"] is True)

    # --- 2. Missing data must stay missing, never become zero ---------------
    print("\n[2] Missing data handling")
    bare = scout.normalise_app({"trackName": "Mystery App"}, 1, "focus")
    check("absent ratingCount -> None not 0", bare["ratingCount"] is None)
    check("absent rating -> None not 0", bare["rating"] is None)
    check("absent price -> isFree None not False", bare["isFree"] is None)
    check("absent releaseDate -> ageDays None", bare["ageDays"] is None)

    empty = scout.analyse_competition([bare], "focus")
    check("no rating data -> competition withheld", empty["medianRatingCount"] is None)
    check("no rating data -> strength withheld", empty["strength"] is None)

    # --- 3. The three scenarios the brief specifies --------------------------
    print("\n[3] Scenario behaviour required by the brief")
    scenarios = {
        "A: no demand, no competition": ([3, 1, 0, 5, 2, 0, 1, 4, 0, 2], False),
        "B: huge demand, brand-dominated": ([2400000, 890000, 450000, 320000, 210000,
                                             180000, 150000, 120000, 99000, 88000], True),
        "C: real demand, 100-500 ratings": ([120, 240, 380, 150, 460, 90, 310, 220, 175, 400], True),
    }
    scores = {}
    for label, (counts, in_autocomplete) in scenarios.items():
        apps = [scout.normalise_app(itunes_record(i, f"Visualization {i}", rc, 4.6), i,
                                    "guided visualization") for i, rc in enumerate(counts, 1)]
        comp = scout.analyse_competition(apps, "guided visualization")
        hints = {"stem": "guided visualizat",
                 "terms": ["guided visualization", "guided meditation"] if in_autocomplete
                 else ["something else"]}
        dem = scout.assess_demand("guided visualization", hints, None, comp)
        opp = scout.opportunity(dem, comp, 5, 5)
        scores[label[0]] = opp["score"]
        print(f"      {label:34s} strength={comp['strength']['score']:>3} "
              f"demand={dem['score']} ({dem['confidence']:<7}) opp={opp['score']:>3} {opp['band']}")

    check("C (beatable) beats B (brand-dominated)", scores["C"] > scores["B"],
          f"C={scores['C']} B={scores['B']}")
    check("C (beatable) beats A (dead keyword)", scores["C"] > scores["A"],
          f"C={scores['C']} A={scores['A']}")
    check("B (brand-dominated) scores near zero", scores["B"] <= 5, f"B={scores['B']}")
    check("A (dead) cannot reach STRONG", scores["A"] < 30, f"A={scores['A']}")

    # --- 4. Zero demand collapses the product -------------------------------
    print("\n[4] Scoring guarantees")
    comp_easy = scout.analyse_competition(
        [scout.normalise_app(itunes_record(i, f"App {i}", 50, 4.5), i, "x") for i in range(1, 11)], "x")
    zero = scout.opportunity({"score": 0.0, "confidence": "HIGH"}, comp_easy, 5, 5)
    check("zero demand -> zero opportunity", zero["score"] == 0)
    unknown = scout.opportunity({"score": None, "confidence": "UNKNOWN"}, comp_easy, 5, 5)
    check("unknown demand -> score withheld, not guessed", unknown["score"] is None)
    unrated = scout.opportunity({"score": 4.0, "confidence": "MEDIUM"}, comp_easy, None, None)
    check("unrated fit/intent -> score withheld", unrated["score"] is None)
    low_conf = scout.opportunity({"score": 4.0, "confidence": "LOW"}, comp_easy, 5, 5)
    check("LOW confidence cannot display STRONG", low_conf["band"] != "STRONG",
          f"band={low_conf['band']}")

    # --- 5. Demand never emits a volume number ------------------------------
    print("\n[5] Demand honesty")
    for hints, err, label in [({"stem": "x", "terms": ["guided visualization"]}, None, "autocomplete hit"),
                              ({"stem": "x", "terms": ["other"]}, None, "autocomplete miss"),
                              (None, "endpoint down", "no hints at all")]:
        d = scout.assess_demand("guided visualization", hints, err, comp_easy)
        check(f"{label}: searchVolume is None", d["searchVolume"] is None)
        check(f"{label}: confidence is labelled", d["confidence"] in
              ("HIGH", "MEDIUM", "LOW", "UNKNOWN"))
        check(f"{label}: reasoning given", bool(d["why"]))
    asa = scout.assess_demand("x", None, None, comp_easy, asa_popularity=74)
    check("Apple Ads popularity -> HIGH confidence", asa["confidence"] == "HIGH")
    check("Apple Ads still emits no volume", asa["searchVolume"] is None)

    # --- 6. Review mining ----------------------------------------------------
    print("\n[6] Review mining")
    mined = scout.mine_reviews([
        {"title": "Too expensive", "body": "The subscription is way overpriced", "rating": 2},
        {"title": "Love it", "body": "This app helped me so much, amazing", "rating": 5},
        {"title": "Needs work", "body": "I wish it had offline downloads", "rating": 3},
        {"title": "Crashes", "body": "It crashes every time I open it", "rating": 1},
    ])
    th = mined["themes"]
    check("pricing complaints bucketed", th["SUBSCRIPTION / PRICING COMPLAINTS"]["count"] >= 1)
    check("praise bucketed", th["WHAT USERS LOVE"]["count"] >= 1)
    check("requests bucketed", th["COMMON REQUESTS"]["count"] >= 1)
    check("complaints bucketed", th["COMMON COMPLAINTS"]["count"] >= 1)
    check("missing features bucketed", th["MISSING FEATURES"]["count"] >= 1)
    check("negative share computed", mined["negativeShare"] == 50)
    check("method disclosed as non-AI", "NOT AI" in mined["method"])
    check("match word shown for audit",
          bool(th["SUBSCRIPTION / PRICING COMPLAINTS"]["samples"][0]["matched"]))

    # --- 7. Product weakness flags ------------------------------------------
    print("\n[7] Product weakness detection")
    stale = scout.normalise_app(itunes_record(9, "Old App", 40, 3.5, shots=2, desc=300,
                                              release="2018-01-01T00:00:00Z",
                                              updated="2023-01-01T00:00:00Z"), 1, "x")
    flags = scout.product_signals(stale)["weaknessFlags"]
    check("abandoned app flagged", any("year" in f for f in flags))
    check("thin screenshots flagged", any("screenshot" in f for f in flags))
    check("short description flagged", any("description" in f for f in flags))
    check("weak rating flagged", any("rating" in f for f in flags))
    check("low traction for age flagged", any("traction" in f for f in flags))
    check("subjective qualities left to human eyes",
          "Visual / screenshot quality" in scout.product_signals(stale)["requiresYourEyes"])

    # --- 8. Exports ----------------------------------------------------------
    print("\n[8] Exports")
    csv_out, json_out = scout.export_csv(), scout.export_json()
    check("CSV has header", "KEYWORD" in csv_out.split("\n")[0])
    check("CSV warns about unavailable metrics", "UNAVAILABLE" in csv_out)
    blob = json.loads(json_out)
    check("JSON lists unavailable metrics", "keyword search volume" in blob["unavailableMetrics"])
    check("JSON documents its sources", "iTunes Search API" in blob["sources"]["serp"])
    check("JSON carries provenance legend", "unavailable" in blob["provenanceLegend"])

    # --- 9. Traction modelling ----------------------------------------------
    print("\n[9] Traction modelling")
    import time as _t
    now = _t.time()
    old_app = scout.normalise_app(itunes_record(20, "Formerly Hot", 400, 4.5,
                                                release="2019-01-01T00:00:00Z"), 1, "x")
    new_app = scout.normalise_app(itunes_record(21, "Actually Rising", 180, 4.7,
                                                release="2026-03-01T00:00:00Z"), 2, "x")
    check("lifetime rate available on first run",
          scout.traction(old_app, {})["lifetimeRatingsPerDay"] is not None)
    check("velocity withheld with one observation",
          scout.traction(old_app, {})["currentRatingsPerDay"] is None)
    short = scout.traction(old_app, {str(old_app["trackId"]): [[now - 3600, 399, 4.5],
                                                               [now, 400, 4.5]]})
    check("sub-1-day window withheld as too short", short["currentRatingsPerDay"] is None)

    hist = {str(old_app["trackId"]): [[now - 14 * 86400, 400, 4.5], [now, 400, 4.5]],
            str(new_app["trackId"]): [[now - 14 * 86400, 120, 4.7], [now, 180, 4.7]]}
    summ = scout.traction_summary([old_app, new_app], hist)
    names = [r["name"] for r in summ["smallRisers"]]
    check("flat formerly-big app is NOT a riser", "Formerly Hot" not in names, str(names))
    check("genuinely growing small app IS a riser", "Actually Rising" in names, str(names))
    check("riser judged on measured velocity",
          summ["smallRisers"][0]["basis"] == "current")
    check("estimate prefers measured velocity", summ["estimateBasis"] == "current velocity")
    check("momentum detects acceleration",
          scout.traction(new_app, hist)["momentum"] > 1)
    check("momentum detects stall", scout.traction(old_app, hist)["momentum"] == 0)

    # --- 10. Download estimate honesty ---------------------------------------
    print("\n[10] Download estimate honesty")
    est = scout.estimate_downloads(2.0)
    check("downloads is a RANGE, never a point", est["perDayLow"] < est["perDayHigh"])
    check("range spans an order of magnitude", est["perDayHigh"] / est["perDayLow"] >= 9)
    check("flagged as estimated", est["provenance"] == "estimated")
    check("uncalibrated state is stated loudly", "UNCALIBRATED" in est["health"])
    check("assumption is disclosed", "ASSUMED" in est["assumption"] or "fitted" in est["assumption"])
    check("warns it adds no ranking information", "ranking information" in est["warning"])
    check("no estimate without a rate", scout.estimate_downloads(None) is None)

    # revenue must appear nowhere
    blob_all = json.dumps({"row": [scout.SESSION.row(k) for k in scout.SESSION.keywords],
                           "est": est, "traction": summ})
    check("revenue never produced anywhere", '"revenue"' not in blob_all.lower())
    check("revenue declared unavailable in export",
          any("revenue" in m for m in json.loads(scout.export_json())["unavailableMetrics"]))

    print("\n" + "=" * 52)
    if FAILS:
        print(f"{len(FAILS)} FAILED:")
        for f in FAILS:
            print("  -", f)
        return 1
    print("All checks passed. Logic is sound; live Apple data still needs a real run.\n")
    return 0


if __name__ == "__main__":
    sys.exit(run())
