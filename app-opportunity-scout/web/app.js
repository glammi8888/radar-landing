/*
 * App Opportunity Scout - browser build
 * =====================================
 * Talks to Apple directly from the page. itunes.apple.com sends no CORS
 * headers, so every call is JSONP (a <script> tag with ?callback=), which is
 * GET-only and cannot set request headers. That is exactly why the autocomplete
 * demand tier is unavailable here - it requires X-Apple-Store-Front.
 *
 * All state lives in this browser's localStorage. Nothing is uploaded.
 */
(function () {
  'use strict';
  const S = window.ScoutScoring;
  const $ = s => document.querySelector(s);

  const SEED = ['guided visualization','visualization','visualization app','guided imagery',
    'mental rehearsal','future self','success visualization','confidence visualization',
    'manifestation visualization','mindset','mindset coach','motivation','motivation coach',
    'daily motivation','confidence','confidence coach','self confidence','manifestation',
    'affirmations','mental reset','mindset reset','focus','focus coach','procrastination',
    'overthinking','creative block','inspiration','discipline','personal growth','life coach'];

  const KEY = 'scout.v1';
  const CACHE_TTL = 7 * 24 * 3600 * 1000;
  const SPACING = 3500;               // Apple allows ~20 req/min per IP
  const SERP_DEPTH = 20;

  let DB = { keywords: {}, results: {}, history: {}, cache: {}, calibration: [] };

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) DB = Object.assign(DB, JSON.parse(raw));
    } catch (e) { /* private mode or blocked storage - run in memory */ }
    if (!Object.keys(DB.keywords).length)
      SEED.forEach(k => { DB.keywords[k] = { productFit: null, commercialIntent: null }; });
  }

  let storageWarned = false;
  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(DB));
      const kb = Math.round(JSON.stringify(DB).length / 1024);
      $('#storage').textContent = `${Object.keys(DB.results).length} researched · ${kb} KB stored locally`;
    } catch (e) {
      if (!storageWarned) {
        storageWarned = true;
        alert('Browser storage is full or blocked, so results cannot be saved between visits.\n\n' +
              'Export to JSON now to keep this research. Deleting keywords you no longer need ' +
              'frees space.');
      }
    }
  }

  /* ---- JSONP with rate limiting and a 7-day cache ---------------------- */
  let queue = Promise.resolve(), lastCall = 0;
  function jsonp(url, timeoutMs) {
    return new Promise((resolve, reject) => {
      const cb = 'scoutcb_' + Math.random().toString(36).slice(2);
      const script = document.createElement('script');
      const timer = setTimeout(() => { cleanup(); reject(new Error(
        'Timed out. Apple may be rate-limiting - wait a minute and retry.')); }, timeoutMs || 20000);
      function cleanup() {
        clearTimeout(timer);
        try { delete window[cb]; } catch (e) { window[cb] = undefined; }
        if (script.parentNode) script.parentNode.removeChild(script);
      }
      window[cb] = data => { cleanup(); resolve(data); };
      script.onerror = () => { cleanup(); reject(new Error(
        'Apple refused the request (usually rate limiting after too many calls). Wait a minute.')); };
      script.src = url + (url.includes('?') ? '&' : '?') + 'callback=' + cb;
      document.head.appendChild(script);
    });
  }

  function fetchCached(url, force) {
    const hit = DB.cache[url];
    if (!force && hit && Date.now() - hit.t < CACHE_TTL) return Promise.resolve(hit.d);
    queue = queue.then(() => {
      const wait = Math.max(0, SPACING - (Date.now() - lastCall));
      return new Promise(res => setTimeout(res, wait));
    }).then(() => {
      lastCall = Date.now();
      return jsonp(url);
    }).then(d => {
      DB.cache[url] = { t: Date.now(), d };
      // Cache can outgrow storage; drop the oldest entries rather than fail.
      const keys = Object.keys(DB.cache);
      if (keys.length > 300) {
        keys.sort((a, b) => DB.cache[a].t - DB.cache[b].t).slice(0, 100)
            .forEach(k => delete DB.cache[k]);
      }
      return d;
    });
    return queue;
  }

  const serpUrl = kw => 'https://itunes.apple.com/search?' + new URLSearchParams({
    term: kw, country: 'us', media: 'software', entity: 'software', limit: SERP_DEPTH });
  const reviewUrl = (id, page) =>
    `https://itunes.apple.com/us/rss/customerreviews/page=${page}/id=${id}/sortby=mostrecent/json`;

  function recordSnapshots(apps) {
    const now = Math.round(Date.now() / 1000);
    apps.forEach(a => {
      if (a.trackId === null || typeof a.ratingCount !== 'number') return;
      const k = String(a.trackId);
      const series = DB.history[k] || (DB.history[k] = []);
      if (series.length) {
        const last = series[series.length - 1];
        if (now - last[0] < 6 * 3600 && last[1] === a.ratingCount) return;
      }
      series.push([now, a.ratingCount, a.rating]);
      if (series.length > 200) series.splice(0, series.length - 200);
    });
  }

  /* ---- research run ---------------------------------------------------- */
  let running = false;
  async function research(keywords, force) {
    running = true;
    const log = [];
    const box = $('#progress'); box.style.display = 'block';
    $('#run').disabled = true;
    log.push('Apple Ads popularity unavailable in the browser build. Demand confidence tops out at LOW.');

    for (let i = 0; i < keywords.length; i++) {
      const kw = keywords[i];
      $('#ptitle').textContent = `Researching ${i + 1}/${keywords.length} — ${kw}`;
      $('#plog').innerHTML = log.slice(-40).reverse().map(esc).join('<br>');
      try {
        const payload = await fetchCached(serpUrl(kw), force);
        const apps = (payload.results || []).map((raw, n) => S.normaliseApp(raw, n + 1, kw));
        if (!apps.length) {
          DB.results[kw] = { error: 'Apple returned no apps for this keyword.', apps: [] };
          log.push(`[${kw}] no results`);
        } else {
          const comp = S.analyseCompetition(apps, kw);
          recordSnapshots(apps);
          const trac = S.tractionSummary(apps, DB.history, riserCap(), DB.calibration);
          const dem = S.assessDemand(kw, comp, {});
          DB.results[kw] = { apps, competition: comp, demand: dem, traction: trac,
            meta: { source: 'iTunes Search API (JSONP)', fetchedAt: new Date().toISOString(),
              resultCount: payload.resultCount,
              rankingCaveat: 'iTunes Search API relevance order - a proxy for the App Store SERP, not identical to it.' },
            error: null };
          log.push(`[${kw}] ${apps.length} apps | competition ${(comp.strength || {}).score} | demand ${dem.confidence}`);
        }
      } catch (err) {
        DB.results[kw] = { error: String(err.message || err), apps: [] };
        log.push(`[${kw}] FAILED: ${err.message || err}`);
      }
      save();
      render();
    }
    $('#ptitle').textContent = `Finished ${keywords.length} keyword` +
      `${keywords.length === 1 ? '' : 's'}.`;
    $('#plog').innerHTML = log.slice(-40).reverse().map(esc).join('<br>');
    $('#run').disabled = false;
    running = false;
    render();
  }

  /* ---- row assembly (mirrors Session.row in scout.py) ------------------ */
  function row(kw) {
    const meta = DB.keywords[kw] || {};
    const res = DB.results[kw];
    const base = { keyword: kw, researched: false, productFit: meta.productFit,
      commercialIntent: meta.commercialIntent, demand: null, demandConfidence: 'UNKNOWN',
      ladder: [], entryBar: null, entryBarMin: null, bestPosSmall: null, rankEvidence: null,
      medianTop10Ratings: null, top10Under500: null, under100: null, under1000: null,
      over10000: null, avgRatingCount: null, dominant: null, opportunity: null,
      opportunityBand: null, riserPairs: [], smallRisers: null, tractionPerDay: null,
      error: null };
    if (!res) return base;
    if (res.error && !(res.apps || []).length) return Object.assign(base, { error: res.error });

    const c = res.competition || {}, d = res.demand || {}, t = res.traction || {};
    const pen = c.penetration || {}, str = c.strength || {};
    const opp = S.opportunity(d, c, meta.productFit, meta.commercialIntent, res.apps);
    const dom = c.dominantIncumbent;
    return Object.assign(base, {
      researched: true,
      demand: d.score, demandConfidence: d.confidence, demandSignal: d.signal,
      ladder: (pen.ladder || []).map(x => x.ratingCount),
      entryBar: pen.entryBarP25, entryBarMin: pen.entryBarMin,
      bestPosSmall: pen.bestPositionBelowMedian,
      bestPosUnder1000: pen.bestPositionUnder1000,
      rankEvidence: (S.rankEvidence(c) || {}).value,
      competition: str.score, competitionBand: str.band,
      medianTop10Ratings: c.medianRatingCount, avgRatingCount: c.avgRatingCount,
      top10Under500: c.under500, pctUnder500: c.pctUnder500,
      under100: c.under100, under1000: c.under1000, over10000: c.over10000,
      avgStars: c.avgStars,
      dominant: dom ? `${dom.name} (${dom.ratingCount.toLocaleString()})` : null,
      riserPairs: (t.growthRanking || []).filter(x => typeof x.ratingCount === 'number')
        .map(x => [x.ratingCount, x.ratingsPerDay]),
      smallRisers: t.smallRiserCount,
      tractionPerDay: t.hasTimeSeries ? t.medianCurrentRatingsPerDay : t.medianLifetimeRatingsPerDay,
      tractionBasis: t.estimateBasis,
      opportunity: opp.score, opportunityBand: opp.band, opportunityReason: opp.reason,
      fetchedAt: (res.meta || {}).fetchedAt, error: res.error
    });
  }

  window.ScoutApp = { DB, load, save, research, row, fetchCached, reviewUrl, jsonp,
    get running() { return running; } };
})();
