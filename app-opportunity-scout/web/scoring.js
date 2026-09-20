/*
 * App Opportunity Scout - scoring logic, ported from scout.py
 * =========================================================
 * This file is a DELIBERATE DUPLICATE of the Python model so the browser build
 * can run with no server. parity-test.mjs runs the same fixtures through both
 * and fails if they ever disagree - do not edit one without the other.
 *
 * Works as an ES module (node, tests) and as a plain <script> (the page).
 */
(function (root) {
  'use strict';

  // Python's round(x, n) rounds the EXACT binary value to nearest, ties-to-even.
  // Multiplying by 10^n first introduces its own float error, and a tolerance
  // like |v-floor(v)-0.5| < 1e-9 wrongly treats values a hair ABOVE half (e.g.
  // 0.0985000000000000042) as exact ties, rounding them down where Python
  // rounds up. So inspect the exact decimal expansion instead. toFixed(20) is
  // correctly rounded and carries far more digits than we compare.
  function r(x, n) {
    if (x === null || x === undefined || typeof x !== 'number' || !isFinite(x)) return null;
    n = n || 0;
    if (Number.isInteger(x)) return x;
    const sign = x < 0 ? -1 : 1;
    const ax = Math.abs(x);
    if (ax >= 1e15) return x;
    const s = ax.toFixed(20);
    const dot = s.indexOf('.');
    const intPart = s.slice(0, dot);
    const frac = s.slice(dot + 1);
    if (n >= frac.length) return x;
    const keep = frac.slice(0, n);
    const rest = frac.slice(n);

    const first = Number(rest[0]);
    let up;
    if (first > 5) up = true;
    else if (first < 5) up = false;
    else {
      const tail = rest.slice(1).replace(/0+$/, '');
      if (tail.length) up = true;                 // strictly greater than half
      else {                                      // an exact tie -> to even
        const lastKept = keep.length ? Number(keep[keep.length - 1])
                                     : Number(intPart[intPart.length - 1]);
        up = (lastKept % 2) === 1;
      }
    }
    const base = Number(intPart + (keep ? '.' + keep : ''));
    const out = up ? base + Math.pow(10, -n) : base;
    return sign * Number(out.toFixed(n));
  }

  function median(xs) {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; }

  function percentile(sortedAsc, p) {
    if (!sortedAsc.length) return null;
    if (sortedAsc.length === 1) return sortedAsc[0];
    const k = (sortedAsc.length - 1) * p;
    const lo = Math.floor(k), hi = Math.ceil(k);
    if (lo === hi) return sortedAsc[k];
    return sortedAsc[lo] * (hi - k) + sortedAsc[hi] * (k - lo);
  }

  function spearman(xs, ys) {
    const n = xs.length;
    if (n < 3) return null;
    const ranks = v => {
      const order = [...Array(n).keys()].sort((a, b) => v[a] - v[b]);
      const out = new Array(n);
      order.forEach((idx, pos) => { out[idx] = pos + 1; });
      return out;
    };
    const rx = ranks(xs), ry = ranks(ys);
    const mx = mean(rx), my = mean(ry);
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) {
      num += (rx[i] - mx) * (ry[i] - my);
      dx += (rx[i] - mx) ** 2;
      dy += (ry[i] - my) ** 2;
    }
    const den = Math.sqrt(dx * dy);
    return den ? r(num / den, 3) : null;
  }

  const DAY = 86400000;

  function normaliseApp(raw, position, keyword) {
    const g = k => {
      const v = raw[k];
      if (v === '' || v === undefined || v === null) return null;
      if (Array.isArray(v) && !v.length) return null;
      return v;
    };
    const now = Date.now();
    const release = g('releaseDate');
    const updated = g('currentVersionReleaseDate');
    const days = iso => {
      if (!iso) return null;
      const t = Date.parse(iso);
      return isNaN(t) ? null : Math.floor((now - t) / DAY);
    };
    const title = g('trackName') || '';
    const kw = (keyword || '').toLowerCase().trim();
    const titleL = title.toLowerCase();
    const tokens = kw.split(/\s+/).filter(Boolean);
    const price = g('price');
    const shots = raw.screenshotUrls || [];
    const desc = g('description') || '';

    return {
      position,
      trackId: g('trackId'),
      name: title || null,
      developer: g('sellerName') || g('artistName'),
      url: g('trackViewUrl'),
      category: g('primaryGenreName'),
      genres: raw.genres || null,
      rating: g('averageUserRating'),
      ratingCount: raw.userRatingCount === undefined ? null : raw.userRatingCount,
      price,
      formattedPrice: g('formattedPrice'),
      isFree: price === null || price === undefined ? null : price === 0,
      version: g('version'),
      releaseDate: release,
      lastUpdate: updated,
      // Storage is localStorage here, so keep an excerpt rather than the full text.
      descriptionExcerpt: desc ? desc.slice(0, 600) : null,
      descriptionLength: desc.length || null,
      icon: g('artworkUrl512') || g('artworkUrl100'),
      screenshots: shots.length ? shots.slice(0, 4) : null,
      screenshotCount: shots.length,
      ipadScreenshotCount: (raw.ipadScreenshotUrls || []).length,
      minimumOsVersion: g('minimumOsVersion'),
      contentRating: g('trackContentRating'),
      languageCount: (raw.languageCodesISO2A || []).length || null,
      ageDays: days(release),
      daysSinceUpdate: days(updated),
      exactMatchInTitle: title ? titleL.includes(kw) : null,
      partialMatchInTitle: title ? (tokens.length > 0 && tokens.some(t => titleL.includes(t))) : null,
      subtitle: null,
      iapTiers: null,
      downloads: null,
      revenue: null
    };
  }

  function penetration(top10) {
    const pairs = top10
      .filter(a => typeof a.ratingCount === 'number')
      .map(a => [a.position, a.ratingCount]);
    if (!pairs.length) return null;
    const counts = pairs.map(p => p[1]).sort((a, b) => a - b);
    const med = median(counts);
    const bestUnder = limit => {
      const hits = pairs.filter(p => p[1] < limit).map(p => p[0]);
      return hits.length ? Math.min(...hits) : null;
    };
    const belowMedian = pairs.filter(p => p[1] < med);
    const bestBelow = belowMedian.length ? Math.min(...belowMedian.map(p => p[0])) : null;
    // Position order, NOT rating order: the ladder shows the SERP as ranked, so
    // you can see where the small apps actually sit. Must match scout.py.
    const byPos = [...pairs].sort((a, b) => a[0] - b[0]);

    return {
      ladder: byPos.map(p => ({ position: p[0], ratingCount: p[1] })),
      entryBarMin: counts[0],
      entryBarP25: r(percentile(counts, 0.25), 1),
      fieldMedian: med,
      bestPositionUnder100: bestUnder(100),
      bestPositionUnder500: bestUnder(500),
      bestPositionUnder1000: bestUnder(1000),
      bestPositionUnder10000: bestUnder(10000),
      positionsUnder500: byPos.filter(p => p[1] < 500).map(p => p[0]),
      positionsUnder1000: byPos.filter(p => p[1] < 1000).map(p => p[0]),
      belowMedianPositions: belowMedian.map(p => p[0]).sort((a, b) => a - b),
      bestPositionBelowMedian: bestBelow,
      inTop5Under1000: pairs.filter(p => p[0] <= 5 && p[1] < 1000).length,
      sizeRankCorrelation: spearman(pairs.map(p => p[0]), pairs.map(p => -p[1])),
      sampleSize: pairs.length
    };
  }

  function competitorStrength(c) {
    const a = 25 * Math.min(Math.log10(c.medianRatingCount + 1) / 5, 1);
    const b = 25 * Math.min(Math.log10(c.maxRatingCount + 1) / 6, 1);
    const n = Math.max(c.sampleSize, 1);
    const cc = 25 * Math.min((c.exactInTitle + 0.5 * c.inTitle) / n, 1);
    const stars = c.avgStars;
    const starPts = stars === null ? 7.5 : 15 * Math.min(Math.max((stars - 3) / 2, 0), 1);
    const freshPts = 10 * Math.min(c.freshlyUpdated / n, 1);
    const d = starPts + freshPts;
    const total = a + b + cc + d;
    return {
      score: r(total, 0),
      band: total >= 66 ? 'HIGH' : (total >= 38 ? 'MEDIUM' : 'LOW'),
      components: {
        ratingMass: r(a, 1), incumbentCeiling: r(b, 1),
        keywordTargeting: r(cc, 1), entrenchment: r(d, 1)
      },
      provenance: 'calculated'
    };
  }

  function analyseCompetition(apps, keyword) {
    const top10 = apps.slice(0, 10);
    const counts = top10.filter(a => typeof a.ratingCount === 'number').map(a => a.ratingCount);
    const stars = top10.filter(a => typeof a.rating === 'number').map(a => a.rating);
    const missing = top10.length - counts.length;

    if (!counts.length) {
      return {
        sampleSize: top10.length, ratingCountsMissing: missing,
        note: 'No rating counts returned for this keyword. Competition cannot be assessed.',
        medianRatingCount: null, avgRatingCount: null, minRatingCount: null,
        maxRatingCount: null, under100: null, under500: null, under1000: null,
        over10000: null, pctUnder500: null, exactInTitle: null, inTitle: null,
        avgStars: null, dominantIncumbent: null, penetration: null,
        freshlyUpdated: null, strength: null
      };
    }

    const exact = top10.filter(a => a.exactMatchInTitle).length;
    const partial = top10.filter(a => a.partialMatchInTitle).length;
    const med = median(counts);
    const maximum = Math.max(...counts);

    let dominant = null;
    const others = [...counts].sort((x, y) => y - x).slice(1);
    const medOthers = others.length ? median(others) : 0;
    if (maximum >= 50000 && (medOthers === 0 || maximum >= 10 * Math.max(medOthers, 1))) {
      const topApp = top10.filter(a => typeof a.ratingCount === 'number')
        .reduce((p, q) => (q.ratingCount > p.ratingCount ? q : p));
      dominant = {
        name: topApp.name, ratingCount: topApp.ratingCount,
        multipleOfFieldMedian: r(maximum / Math.max(medOthers, 1), 1),
        scoringImpact: 'none - descriptive flag only',
        thresholdCaveat: 'Flagged at >=50,000 ratings AND >=10x the rest of the field. ' +
          'Those cutoffs are labelling conventions, not evidence.'
      };
    }

    const fresh = top10.filter(a => typeof a.daysSinceUpdate === 'number' && a.daysSinceUpdate <= 180).length;

    const comp = {
      sampleSize: top10.length, ratingCountsMissing: missing,
      medianRatingCount: med, avgRatingCount: r(mean(counts), 1),
      minRatingCount: Math.min(...counts), maxRatingCount: maximum,
      under100: counts.filter(x => x < 100).length,
      under500: counts.filter(x => x < 500).length,
      under1000: counts.filter(x => x < 1000).length,
      over10000: counts.filter(x => x > 10000).length,
      pctUnder500: r(100 * counts.filter(x => x < 500).length / counts.length, 0),
      exactInTitle: exact, inTitle: partial,
      avgStars: stars.length ? r(mean(stars), 2) : null,
      freshlyUpdated: fresh, dominantIncumbent: dominant
    };
    comp.penetration = penetration(top10);
    comp.strength = competitorStrength(comp);
    return comp;
  }

  function rankEvidence(comp) {
    const pen = comp && comp.penetration;
    if (!pen) return null;
    let entry = 1 - (Math.log10(pen.entryBarP25 + 1) / Math.log10(50000));
    entry = Math.max(0.03, Math.min(entry, 1));
    const best = pen.bestPositionBelowMedian;
    const n = Math.max(pen.sampleSize || 10, 1);
    const reach = best === null ? 1 : Math.max(0.15, 1 - (best - 1) / n);
    return {
      value: r(entry * reach, 4),
      components: { entryFactor: r(entry, 3), reachFactor: r(reach, 3) },
      entryBarP25: pen.entryBarP25, entryBarMin: pen.entryBarMin,
      bestPositionBelowMedian: best,
      dominantIncumbentImpact: 'none - large competitors do not reduce this score',
      provenance: 'calculated'
    };
  }

  root.ScoutScoring = { r, median, mean, percentile, spearman, normaliseApp,
    penetration, competitorStrength, analyseCompetition, rankEvidence };
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* ---- part 2: product signals, demand, traction, opportunity, reviews ---- */
(function (root) {
  'use strict';
  const S = root.ScoutScoring;
  const { r, median, mean } = S;

  function productSignals(app) {
    const flags = [];
    const dsu = app.daysSinceUpdate;
    if (typeof dsu === 'number') {
      if (dsu > 365) flags.push('Abandoned-looking: no update in over a year');
      else if (dsu > 180) flags.push('Slow cadence: no update in 6+ months');
    }
    if (typeof app.screenshotCount === 'number' && app.screenshotCount <= 3)
      flags.push('Thin screenshot set (<=3) - weak store presentation');
    if (typeof app.descriptionLength === 'number' && app.descriptionLength < 600)
      flags.push('Very short description - listing likely unoptimised');
    if (typeof app.rating === 'number' && app.rating < 4)
      flags.push(`Weak rating (${app.rating}) - user dissatisfaction`);
    if (typeof app.ratingCount === 'number' && typeof app.ageDays === 'number'
        && app.ageDays > 730 && app.ratingCount < 200)
      flags.push('Low traction for its age - years old, still few ratings');
    return {
      observable: {
        screenshotCount: app.screenshotCount,
        hasIpadScreenshots: !!app.ipadScreenshotCount,
        descriptionLength: app.descriptionLength,
        daysSinceUpdate: app.daysSinceUpdate, ageDays: app.ageDays,
        localisations: app.languageCount, pricing: app.formattedPrice
      },
      requiresYourEyes: ['Visual / screenshot quality', 'Positioning clarity',
        'Apparent product sophistication', 'Differentiation'],
      weaknessFlags: flags, weaknessCount: flags.length
    };
  }

  function listingWeakness(apps) {
    const top10 = apps.slice(0, 10);
    if (!top10.length) return null;
    const flags = top10.map(a => productSignals(a).weaknessFlags.length);
    const weakShare = flags.filter(f => f).length / flags.length;
    return {
      appsWithWeakness: flags.filter(f => f).length,
      sampleSize: flags.length,
      weakShare: r(weakShare, 2),
      avgFlagsPerApp: r(mean(flags), 2),
      modifier: r(0.85 + 0.4 * weakShare, 3),
      formula: '0.85 + 0.4 * (share of top 10 with >=1 listing weakness)',
      provenance: 'calculated'
    };
  }

  const NO_VOLUME = 'UNAVAILABLE without a paid ASO provider or Apple Ads credentials.';

  /*
   * Demand in the browser build.
   *
   * The autocomplete tier that the local build uses is NOT reachable here: that
   * endpoint needs an X-Apple-Store-Front request header, and JSONP (a <script>
   * tag) cannot set headers. So this build tops out at LOW confidence and says
   * so, rather than quietly presenting a weaker signal as the same thing.
   */
  function assessDemand(keyword, comp, opts) {
    opts = opts || {};
    if (opts.asaPopularity !== undefined && opts.asaPopularity !== null) {
      return {
        score: r(Math.max(0, (opts.asaPopularity - 5) / 95 * 5), 2),
        confidence: 'HIGH', provenance: 'verified',
        signal: `Apple Ads Search Popularity = ${opts.asaPopularity}/100`,
        why: "Apple's own search-popularity index for this term.",
        searchVolume: null,
        searchVolumeNote: 'Apple publishes a popularity index, not a volume.'
      };
    }
    if (comp && comp.exactInTitle !== null && comp.exactInTitle !== undefined) {
      const targeting = comp.exactInTitle + 0.5 * comp.inTitle;
      if (targeting >= 2) {
        return {
          score: r(Math.min(2.5, 0.8 + 0.25 * targeting), 2),
          confidence: 'LOW', provenance: 'proxy',
          signal: `${comp.exactInTitle} exact + ${comp.inTitle} partial title matches in top 10`,
          why: 'Inferred from SUPPLY, not demand: developers put a term in their title when ' +
               'they believe people search it. Capped at 2.5/5. Apple autocomplete, which ' +
               'would raise this to MEDIUM, needs a request header the browser build cannot ' +
               'send - run the local version for that.',
          searchVolume: null, searchVolumeNote: NO_VOLUME
        };
      }
    }
    return {
      score: null, confidence: 'UNKNOWN', provenance: 'unavailable',
      signal: 'No demand signal obtainable in the browser build.',
      why: 'Too few competitors target this term for the supply-side proxy, and Apple ' +
           'autocomplete needs a request header JSONP cannot set. The opportunity score ' +
           'is withheld rather than guessed. The local build can reach MEDIUM confidence.',
      searchVolume: null, searchVolumeNote: NO_VOLUME
    };
  }

  const DEFAULT_RATING_RATE_BAND = [0.005, 0.05];
  const DEFAULT_RISER_MAX_RATINGS = 500;
  const RISER_MIN_RATE = 0.3;

  function ratingRateBand(calib) {
    if (calib && calib.length) {
      const rates = calib.map(p => p.ratings / p.downloads).filter(x => x > 0);
      if (rates.length) return { band: [Math.min(...rates), Math.max(...rates)],
        source: `fitted from ${rates.length} ground-truth pair(s) you supplied`, n: rates.length };
    }
    return { band: DEFAULT_RATING_RATE_BAND,
      source: 'ASSUMED default band (0.5%-5%) - an industry rule of thumb, not measured data',
      n: 0 };
  }

  function estimateDownloads(ratingsPerDay, calib) {
    if (ratingsPerDay === null || ratingsPerDay === undefined) return null;
    const { band, source, n } = ratingRateBand(calib);
    const [lo, hi] = band;
    return {
      perDayLow: r(ratingsPerDay / hi, 1), perDayHigh: r(ratingsPerDay / lo, 1),
      perMonthLow: r(ratingsPerDay / hi * 30, 0), perMonthHigh: r(ratingsPerDay / lo * 30, 0),
      ratingRateBand: band, calibrationPairs: n, assumption: source, provenance: 'estimated',
      health: n ? 'CALIBRATED against your own data'
                : 'UNCALIBRATED - this is an assumption, not a measurement',
      warning: 'Dividing every app by the same rate does not change which keyword ranks ' +
               'highest. This adds a sense of absolute scale, not ranking information.'
    };
  }

  function traction(app, hist) {
    const out = {
      lifetimeRatingsPerDay: null, currentRatingsPerDay: null, momentum: null,
      observationDays: null, snapshots: 0, ratingsGained: null, accelerating: null,
      note: null, provenance: 'calculated'
    };
    if (typeof app.ratingCount === 'number' && typeof app.ageDays === 'number' && app.ageDays > 0)
      out.lifetimeRatingsPerDay = r(app.ratingCount / app.ageDays, 3);

    const series = (hist || {})[String(app.trackId)] || [];
    out.snapshots = series.length;
    if (series.length < 2) {
      out.note = 'Only one observation so far. Re-run research in a few days and current ' +
                 'velocity appears here.';
      return out;
    }
    const [t0, rc0] = series[0], [t1, rc1] = series[series.length - 1];
    const days = (t1 - t0) / 86400;
    if (days < 1) {
      out.note = `Observation window is only ${(days * 24).toFixed(1)}h - too short to be meaningful.`;
      return out;
    }
    out.observationDays = r(days, 1);
    out.ratingsGained = rc1 - rc0;
    out.currentRatingsPerDay = r((rc1 - rc0) / days, 3);
    if (out.lifetimeRatingsPerDay) {
      out.momentum = r(out.currentRatingsPerDay / out.lifetimeRatingsPerDay, 2);
      out.accelerating = out.momentum > 1.2;
    }
    if (days < 7)
      out.note = `Only ${out.observationDays} days of observation - treat velocity as provisional.`;
    return out;
  }

  function tractionSummary(apps, hist, riserMax, calib) {
    riserMax = riserMax || DEFAULT_RISER_MAX_RATINGS;
    const top10 = apps.slice(0, 10);
    top10.forEach(a => { a.traction = traction(a, hist); });
    const life = top10.map(a => a.traction.lifetimeRatingsPerDay).filter(x => x !== null);
    const cur = top10.map(a => a.traction.currentRatingsPerDay).filter(x => x !== null);
    const accel = top10.filter(a => a.traction.accelerating);

    const bestRate = a => a.traction.currentRatingsPerDay !== null
      ? [a.traction.currentRatingsPerDay, 'current']
      : [a.traction.lifetimeRatingsPerDay, 'lifetime'];

    const ranking = [];
    top10.forEach(a => {
      const [rate, basis] = bestRate(a);
      if (rate === null || rate === undefined) return;
      ranking.push({ name: a.name, ratingCount: a.ratingCount, ratingsPerDay: rate, basis,
        momentum: a.traction.momentum, accelerating: a.traction.accelerating });
    });
    ranking.sort((a, b) => b.ratingsPerDay - a.ratingsPerDay);
    const risers = ranking.filter(x => typeof x.ratingCount === 'number'
      && x.ratingCount < riserMax && x.ratingsPerDay >= RISER_MIN_RATE);
    const headline = cur.length ? median(cur) : (life.length ? median(life) : null);

    return {
      medianLifetimeRatingsPerDay: life.length ? r(median(life), 3) : null,
      medianCurrentRatingsPerDay: cur.length ? r(median(cur), 3) : null,
      acceleratingCount: cur.length ? accel.length : null,
      smallRisers: risers, smallRiserCount: risers.length,
      growthRanking: ranking, riserMaxRatings: riserMax, riserMinRate: RISER_MIN_RATE,
      hasTimeSeries: !!cur.length,
      estimateBasis: cur.length ? 'current velocity' : 'lifetime average',
      estimatedDownloads: estimateDownloads(headline, calib)
    };
  }

  function opportunity(demand, comp, productFit, commercialIntent, apps) {
    const ev = comp ? S.rankEvidence(comp) : null;
    if (demand.score === null || demand.score === undefined || !ev) {
      return {
        score: null,
        reason: 'Withheld: ' + ((demand.score === null || demand.score === undefined)
          ? 'no demand signal.' : 'no usable SERP rating distribution.'),
        factors: null
      };
    }
    const weak = apps ? listingWeakness(apps) : null;
    const factors = {
      demand: { raw: demand.score, norm: demand.score / 5, kind: 'objective',
        role: 'gate', note: demand.signal },
      smallAppsCanRank: { raw: r(ev.value * 5, 2), norm: ev.value, kind: 'objective',
        role: 'gate', components: ev.components,
        note: `Entry bar around ${ev.entryBarP25} ratings (lowest on the page: ${ev.entryBarMin})`
          + (ev.bestPositionBelowMedian ? `, a below-median app reaches #${ev.bestPositionBelowMedian}.` : '.') },
      productFit: { raw: productFit, norm: (productFit || 0) / 5, kind: 'subjective',
        role: 'gate', note: 'Your rating.' },
      commercialIntent: { raw: commercialIntent, norm: (commercialIntent || 0) / 5,
        kind: 'subjective', role: 'gate', note: 'Your rating.' }
    };
    if (weak) factors.listingWeakness = {
      raw: `${weak.appsWithWeakness}/${weak.sampleSize} weak listings`,
      norm: weak.modifier, kind: 'objective', role: 'modifier', note: weak.formula
    };

    if (productFit === null || productFit === undefined
        || commercialIntent === null || commercialIntent === undefined) {
      return { score: null,
        reason: 'Withheld: rate PRODUCT FIT and COMMERCIAL INTENT (1-5) to compute.', factors };
    }

    let core = 1;
    ['demand', 'smallAppsCanRank', 'productFit', 'commercialIntent']
      .forEach(k => { core *= Math.max(factors[k].norm, 0); });
    const modifier = weak ? weak.modifier : 1;
    const score = r(Math.min(core * modifier, 1) * 100, 0);

    let band = score >= 30 ? 'STRONG' : (score >= 15 ? 'WORTH A LOOK' : 'WEAK');
    let gated = null;
    if (band === 'STRONG' && (demand.confidence === 'LOW' || demand.confidence === 'UNKNOWN')) {
      band = 'WORTH A LOOK';
      gated = `Capped below STRONG: demand confidence is ${demand.confidence}. ` +
              'Get a real demand signal first.';
    }
    return { score, band, bandGate: gated, factors, confidence: demand.confidence,
      listingWeakness: weak,
      competitorStrengthContext: (comp.strength || {}).score,
      formula: '100 * demand * smallAppsCanRank * productFit * commercialIntent * listingWeaknessModifier',
      caveat: 'Two of four gates are your own subjective ratings. The score RANKS candidates - ' +
              'it measures nothing. Read the Top-10 distribution before trusting it.' };
  }

  const REVIEW_THEMES = {
    'SUBSCRIPTION / PRICING COMPLAINTS': ['subscription', 'expensive', 'paywall', 'refund',
      'free trial', 'charged', 'cancel', 'per month', 'rip off', 'ripoff', 'overpriced',
      'pay wall', 'money', 'price', 'not free', 'scam'],
    'COMMON COMPLAINTS': ['crash', 'bug', 'buggy', 'freeze', 'froze', 'glitch', 'broken',
      "doesn't work", 'does not work', "won't load", 'error', 'stuck', 'useless',
      'disappointed', 'repetitive', 'generic', 'boring', 'annoying', 'laggy'],
    'COMMON REQUESTS': ['wish', 'would love', 'please add', 'hope you add', 'feature request',
      'needs a', 'should have', 'would be nice', 'suggestion', 'please make'],
    'MISSING FEATURES': ['offline', 'download', 'apple watch', 'widget', 'dark mode', 'timer',
      'customize', 'customise', 'custom', 'alarm', 'reminder', 'ipad', 'sync', 'export',
      'no way to', "can't add", 'cannot add'],
    'WHAT USERS LOVE': ['love', 'amazing', 'helped', 'life changing', 'life-changing', 'best',
      'perfect', 'grateful', 'excellent', 'wonderful', 'obsessed', 'favorite', 'favourite',
      'game changer']
  };

  function mineReviews(reviews) {
    const buckets = {};
    Object.keys(REVIEW_THEMES).forEach(k => { buckets[k] = []; });
    reviews.forEach(rv => {
      const text = `${rv.title || ''} ${rv.body || ''}`.toLowerCase();
      Object.entries(REVIEW_THEMES).forEach(([theme, needles]) => {
        const hit = needles.find(n => text.includes(n));
        if (hit) buckets[theme].push({ matched: hit, rating: rv.rating, title: rv.title,
          excerpt: (rv.body || '').slice(0, 320) });
      });
    });
    const ratings = reviews.map(x => x.rating).filter(Boolean);
    const breakdown = {};
    if (ratings.length) for (let s = 1; s <= 5; s++)
      breakdown[s] = ratings.filter(x => x === s).length;
    const themes = {};
    Object.entries(buckets).forEach(([k, v]) => {
      themes[k] = { count: v.length, samples: v.slice(0, 8) };
    });
    return {
      method: 'Literal keyword matching against fixed word lists - NOT AI analysis and NOT ' +
              'sentiment analysis. Every match shows the exact word that triggered it.',
      reviewsAnalysed: reviews.length,
      ratingBreakdown: ratings.length ? breakdown : null,
      negativeShare: ratings.length
        ? r(100 * ratings.filter(x => x <= 2).length / ratings.length, 0) : null,
      themes,
      coverageCaveat: "Apple's public feed serves only the ~500 most recent US reviews. " +
                      'This is a recency-biased sample, not the full review history.'
    };
  }

  Object.assign(S, { productSignals, listingWeakness, assessDemand, estimateDownloads,
    ratingRateBand, traction, tractionSummary, opportunity, mineReviews, REVIEW_THEMES,
    DEFAULT_RISER_MAX_RATINGS, RISER_MIN_RATE });

  if (typeof module !== 'undefined' && module.exports) module.exports = S;
})(typeof globalThis !== 'undefined' ? globalThis : this);
