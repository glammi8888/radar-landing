#!/usr/bin/env python3
"""
Emits parity-golden.json: fixtures plus the Python model's exact outputs.
web/parity-test.mjs replays the same fixtures through the JavaScript port and
fails if any number differs. Run this whenever scout.py's model changes.

    python3 parity.py && node web/parity-test.mjs
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scout
from selftest import itunes_record

# Fixed timestamps so both languages see identical inputs.
NOW = 1_780_000_000

SERPS = {
    "brief_example_A": [50000, 8000, 700, 420, 180, 95],
    "brief_example_B": [300, 250, 150, 90],
    "locked_field": [900000, 400000, 300000, 250000, 180000, 120000, 110000, 105000, 101000, 100000],
    "none_under_500": [900, 800, 700, 600, 550, 520, 510, 505, 502, 501],
    "small_app_at_1": [95, 50000, 8000, 700, 420, 180],
    "identical_sizes": [500, 500, 500, 500, 500, 500],
    "mixed_quality": [120, 1200, 380, 4500, 460, 90, 310, 2200, 175, 400],
}
DEMANDS = [
    {"score": 4.0, "confidence": "MEDIUM", "signal": "fixture"},
    {"score": 0.6, "confidence": "LOW", "signal": "fixture"},
    {"score": None, "confidence": "UNKNOWN", "signal": "fixture"},
]

out = {"now": NOW, "cases": []}
for name, counts in SERPS.items():
    raws = [itunes_record(i, f"App {i}", rc, 4.5,
                          shots=2 if i % 3 == 0 else 6,
                          desc=300 if i % 4 == 0 else 1800,
                          release="2021-03-04T07:00:00Z",
                          updated="2026-06-01T07:00:00Z")
            for i, rc in enumerate(counts, 1)]
    apps = [scout.normalise_app(raw, i, "guided visualization")
            for i, raw in enumerate(raws, 1)]
    comp = scout.analyse_competition(apps, "guided visualization")
    hist = {str(a["trackId"]): [[NOW - 14 * 86400, max(a["ratingCount"] - (i + 1) * 7, 0), 4.5],
                                [NOW, a["ratingCount"], 4.5]]
            for i, a in enumerate(apps)}
    trac = scout.traction_summary(apps, hist)

    case = {
        "name": name,
        "keyword": "guided visualization",
        "raws": raws,
        "history": hist,
        "expect": {
            "competition": {k: v for k, v in comp.items() if k != "penetration"},
            "penetration": comp["penetration"],
            "rankEvidence": scout.rank_evidence(comp),
            "listingWeakness": scout.listing_weakness(apps),
            "tractionSummary": {k: v for k, v in trac.items() if k != "growthRanking"},
            "growthRanking": trac["growthRanking"],
            "productSignalsFirst": scout.product_signals(apps[0]),
            "normalisedFirst": {k: v for k, v in apps[0].items()
                                if k not in ("description", "releaseNotes", "screenshots",
                                             "traction", "genres")},
            "opportunities": [
                scout.opportunity(d, comp, 5, 4, apps) for d in DEMANDS
            ],
        },
    }
    out["cases"].append(case)

with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "parity-golden.json"), "w") as fh:
    json.dump(out, fh, indent=1)
print(f"parity-golden.json written: {len(out['cases'])} cases, "
      f"{len(DEMANDS)} demand variants each")
