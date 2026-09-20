# App Opportunity Scout

Keyword opportunity research for the **US Apple App Store (iPhone)**.

Answers one question: **which App Store search opportunity should I position my app around?**

```bash
python3 scout.py          # -> http://localhost:8787
python3 selftest.py       # offline logic check, no network
```

Python 3.9+. **Zero dependencies.**

---

## The honesty contract

This tool is built so it cannot quietly make things up.

| | |
|---|---|
| **Verified** | Returned directly by an Apple public endpoint |
| **Calculated** | Computed here from verified data, with the formula printed next to it |
| **Proxy** | An indirect signal, labelled as such |
| **Subjective** | Your own 1–5 rating |
| **Unavailable** | Needs a paid provider or credentials we don't have |

**Never produced, at all:** keyword search volume, keyword difficulty, **revenue**.
These need a paid provider or inputs nobody outside the developer can observe.
They render as `UNAVAILABLE`, never as a number.

**Downloads appear only as a wide range**, built from measured rating velocity divided
by one rating-rate assumption you control. See *Traction* below. Missing data stays `None` — it never
silently becomes `0`.

**The big caveat:** app ordering comes from the **iTunes Search API's relevance engine,
which is not the App Store's live search ranking.** We don't scrape `apps.apple.com/search`
because `robots.txt` disallows `/search`. What this data reliably tells you is the
*competitive composition* of a space (how many apps have under 500 ratings, is there a
2M-rating incumbent). It does not reliably tell you that app #4 outranks app #7.

---

## Data sources

| Source | Auth | Gives us |
|---|---|---|
| iTunes Search API | none | name, developer, URL, category, stars, rating count, price, description, version, release date, last update, screenshots, icon |
| Customer Reviews RSS | none | ~500 most recent US reviews per app |
| App Store autocomplete | none | Apple's own suggestion terms + rank |
| Apple Ads Platform API | **your credentials** | official Search Popularity 1–100 |

**Rate limit:** iTunes allows roughly **20 requests/minute per IP**, unauthenticated, with no
key to raise it. We space requests 3.5s apart and cache to disk for 7 days. A 30-keyword run
takes ~4 minutes once; after that it's instant until the cache expires.

### Not available from any free source

- **Subtitle** — not in the Search API. Only on the product page.
- **In-app purchase tiers** — same. "Free vs paid" we do get.

---

## Traction: the closest honest thing to "downloads"

Three layers, and they are **not** equally trustworthy. The UI keeps them separate.

| Layer | What | Trust |
|---|---|---|
| **L1 OBSERVED** | Rating counts sampled across research runs | Apple's own numbers. No model. |
| **L2 CALCULATED** | Velocity, momentum, risers | Arithmetic on L1. Formula shown. |
| **L3 ESTIMATED** | Downloads range | One ~10x-uncertain assumption. Order of magnitude only. |

### L1/L2 — velocity and momentum

```
lifetimeRatingsPerDay = ratingCount / ageDays      # available on run 1
currentRatingsPerDay  = (newest - oldest) / days   # needs 2+ runs, >=1 day apart
momentum              = current / lifetime          # >1.2 = accelerating now
```

`lifetime` is available immediately but blunt: an app that was big years ago and has since
gone flat still scores well on it. `current` is the real signal, and it needs you to **run
research twice, a few days apart**. Every run snapshots into `history.json` automatically.

**Small risers** are the money metric, and directly answer "*are smaller apps getting
traction?*": apps under 500 ratings gaining ≥0.3 ratings/day. Judged on measured velocity
where available, lifetime average otherwise — so a formerly-hot, now-dead app is correctly
excluded. That combination (demand proven, no entrenched moat) is the pattern you're hunting.

### L3 — the download range

```
downloads/day = ratingsPerDay / ratingRate
```

`ratingRate` — what fraction of users leave a rating — is the whole ballgame, and it varies
by roughly **10x** across genres and depending on whether an app uses `SKStoreReviewController`.
So the output is **always a range, never a point**, and the default band (0.5%–5%) is an
industry rule of thumb, **not measured data**.

> **This adds no ranking information.** Dividing every app by the same constant doesn't change
> which keyword comes out on top. It only gives you a sense of absolute scale — useful for
> "is 50/day worth building for?", useless for choosing between keywords.

**Calibrate it** to make it real. Create `calibration.json`:

```json
{"pairs": [
  {"label": "my other app", "downloads": 50000, "ratings": 610},
  {"label": "public disclosure", "downloads": 1000000, "ratings": 14200}
]}
```

Pairs can come from your own App Store Connect or any public disclosure. The tool fits the
rate from them, narrows the band, and flips the status chip to `CALIBRATED`.

### Why there is no revenue number

Revenue needs `downloads × free-to-paid conversion × retention`. Conversion is **unobservable**
for any app but your own — it isn't in any public Apple endpoint, and it swings from under 1%
to over 10%. Multiplying an estimated range by an invented conversion rate and an invented
retention curve is an assumption cubed. The tool shows the observable part (free vs paid) and
stops there.

If you want revenue signal, the honest route is the **top-grossing chart**: presence on it is
public, verifiable, and tells you a category monetizes — without pretending to a dollar figure.

---

## Enabling real demand data (optional)

Without credentials, demand tops out at **MEDIUM** confidence, inferred from Apple's
autocomplete. To reach **HIGH**, you need Apple's own Search Popularity index:

1. An active **Apple Ads** account — **Indie plan or higher**.
2. **Apple Ads → Account Settings → API** → create API access / upload a public key.
3. Apple shows you **`clientId`**, **`teamId`**, **`keyId`**. Keep your **ES256 private key** (`.pem`).
4. Create `asa_credentials.json` next to `scout.py`:

```json
{
  "clientId": "SEARCHADS.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "teamId":   "SEARCHADS.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "keyId":    "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "privateKeyPath": "/absolute/path/to/private-key.pem"
}
```

5. `pip install 'pyjwt[crypto]'` — signing the client-secret JWT needs ES256, which the
   Python stdlib can't do. This is the tool's only optional dependency.

The private key never leaves your machine. `asa_credentials.json` and `*.pem` are gitignored.

---

## How the numbers are built

### Demand (0–5, with confidence)

| Confidence | Source | Cap |
|---|---|---|
| **HIGH** | Apple Ads Search Popularity 1–100 | 5.0 |
| **MEDIUM** | Keyword present in Apple autocomplete, scored by rank | 4.0 |
| **LOW** | Absent from autocomplete, or supply-side inference only | 2.5 |
| **UNKNOWN** | No signal — **opportunity score is withheld** | — |

Autocomplete is genuine evidence (Apple only completes queries people type) but it's
**ordinal**, so it's capped below 5 on purpose. No volume number is ever emitted.

### The central question: can small apps rank here?

**Low competition is not opportunity.** A field of four tiny apps may simply have no demand.
A 50,000-rating incumbent at #1 does **not** disqualify a keyword if 95- and 420-rating apps
hold slots beside it.

So the model asks one thing: **can relatively small or new apps successfully rank for this
keyword?** It answers from the observed Top-10 distribution, with no pass/fail thresholds.

> **Rating count is a proxy for competitor *traction*.** It is not keyword difficulty, not
> downloads, and not search demand. Nothing in this tool treats it as any of those.

**Under-500 is one signal among many, never a requirement.** The full distribution is
reported and shown raw: median, average, counts under 100 / 500 / 1,000, count over 10,000,
the exact positions smaller apps occupy, and the whole rating ladder in rank order.

```
entryFactor = 1 - log10(entryBarP25 + 1) / log10(50000)
   entryBarP25 is the 25th percentile of top-10 rating counts — the FLOOR, not the median.
   You don't need to match the median to appear; you need to clear what the weakest
   ranked apps cleared.

reachFactor = 1 - (bestPositionBelowMedian - 1) / sampleSize
   How HIGH a below-median app gets. Reaching #2 means size isn't gating rank.
   Only appearing at #9–#10 means the SERP is stratified by size.

smallAppsCanRank = entryFactor × reachFactor
```

A dominant incumbent is still **detected and displayed** — it just carries
`scoringImpact: "none"`. Excluding keywords because a large competitor exists throws away
exactly the opportunities worth having.

### Competitor strength (0–100) — context only

Reported beside the distribution, **not** folded into the opportunity score (that would
double-count the same rating data). **Not an industry-standard ASO difficulty score.** Four
observable components, 25 points each:

```
A. Rating mass        25 * log10(medianTop10 + 1) / 5
B. Incumbent ceiling  25 * log10(maxTop10 + 1) / 6
C. Keyword targeting  25 * (exactInTitle + 0.5*inTitle) / n
D. Entrenchment       15 * (avgStars - 3)/2  +  10 * (freshlyUpdated / n)
```

### Opportunity (0–100)

```
100 × demand × smallAppsCanRank × productFit × commercialIntent × listingWeaknessModifier
```

Four **gates**, multiplied, because each can independently kill a candidate: no demand,
can't rank, wrong market, can't monetize. Listing weakness is a **modifier** (0.85–1.25),
not a gate — weak incumbent listings make entry easier, but strong ones don't disqualify.

Bands: `STRONG ≥ 30`, `WORTH A LOOK ≥ 15`, else `WEAK`. LOW or UNKNOWN demand confidence
**can never display STRONG**. Withheld entirely when demand or the SERP distribution is
unknown, or when you haven't rated fit and intent.

**The score ranks candidates. It measures nothing.** Every input is shown next to it, and
the raw ladder is in the main table precisely so you can overrule it.

#### Worked examples

| SERP | Read |
|---|---|
| `50k · 8k · 700 · 420 · 180 · 95` | **Attractive.** Entry bar 95, small apps at #3–#6. The big incumbent is irrelevant to whether you can rank. |
| `300 · 250 · 150 · 90` | **Not automatically good.** Trivially enterable, but likely no demand — and demand is a gate. |
| `900k · 400k · … · 100k` | **Locked.** Nothing small ranks at all. Entry bar 100k. |
| `900 · 800 · … · 501` | **Scoreable.** Zero apps under 500, yet the floor is ~506 — still enterable. No arbitrary cutoff zeroes it. |

---

## Using it

- **Add keywords** — type one, or paste a comma/newline-separated list.
- **Delete** — shift-click a keyword.
- **Rate** — click 1–5 under Product Fit / Commercial Intent. Click the same number to clear.
- **Rerun** — "Run research" acts on whatever the filter currently shows.
- **Sort** — click any column header. Unknowns always sink to the bottom.
- **Drill in** — click a keyword: Demand → Opportunity → Competitor strength → Top apps →
  Weak listings → Related terms.
- **Reviews** — "Analyse reviews" on any app pulls its public reviews and buckets them into
  complaints / requests / praise / missing features / pricing gripes.
- **Export** — CSV and JSON. **Save session** snapshots into `sessions/`.
- **Re-run in a few days** — this is what turns lifetime averages into measured velocity.
  It's the single highest-value habit with this tool.

### Review mining is keyword matching, not AI

Reviews are bucketed by **literal word lists** (`scout.py` → `REVIEW_THEMES`). Every match
displays the exact word that triggered it so you can audit it. It is not sentiment analysis
and not AI. Apple's feed serves only the ~500 most recent US reviews — a recency-biased
sample, not the full history. For real qualitative work, read the excerpts yourself.

---

## What you're hunting

Not the lowest competition. The pattern is:

> **meaningful demand + evidence smaller apps can rank + competitor strength + product/listing
> weakness + product fit + commercial intent**

- Zero demand, zero competition → **bad** (demand is a gate)
- Huge demand, nothing small ranking anywhere → **bad for a new app**
- Real demand, small apps visibly holding top-10 slots, weak listings → **this is the one**,
  *whether or not* a big incumbent sits at #1

Sort by Opportunity, then open the top few and *actually look at the competitors' screenshots*.
The tool narrows 30 keywords to 5 worth your attention. It doesn't make the call.

---

## Files

```
scout.py        fetching, metrics, scoring, local server, exports
dashboard.html  the UI
selftest.py     offline pipeline test (no network)
sessions/       saved research sessions
cache/          raw Apple responses, 7-day TTL (gitignored)
history.json    rating-count snapshots over time, powers velocity (gitignored)
calibration.json  optional ground-truth pairs for the download estimate (gitignored)
```
