/* UI layer for the browser build. Column set and detail view mirror the local
 * dashboard; data comes from local computation instead of a server. */
(function () {
  'use strict';
  const S = window.ScoutScoring, A = window.ScoutApp, DB = A.DB;
  const $ = s => document.querySelector(s);
  let sortKey = 'opportunity', sortDir = -1;

  const esc = s => String(s ?? '').replace(/[&<>"]/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  window.esc = esc;
  const na = t => `<span class="na" title="${esc(t || 'Not available')}">&mdash;</span>`;
  const dot = c => `<span class="dot ${c}"></span>`;
  const demandColor = v => v >= 3 ? 'g' : v >= 1.8 ? 'y' : 'r';
  const rankColor = v => v >= 0.30 ? 'g' : v >= 0.12 ? 'y' : 'r';
  const oppColor = v => v >= 30 ? 'g' : v >= 15 ? 'y' : 'r';
  const abbr = n => n == null ? '—' : (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M'
    : n >= 1e3 ? Math.round(n / 1e3) + 'k' : Math.round(n));
  const RISER_MIN_RATE = 0.3;
  window.riserCap = () => +(($('#cap') || {}).value || 500);
  const risersFor = r => !r.riserPairs ? r.smallRisers
    : r.riserPairs.filter(([rc, rate]) => rc < window.riserCap() && rate >= RISER_MIN_RATE).length;

  function ladder(r) {
    if (!r.ladder || !r.ladder.length) return na('Run research');
    return '<span class="ladder">' + r.ladder.map(c =>
      `<i class="${c < 1000 ? 'sm' : ''}">${abbr(c)}</i>`).join('<u>·</u>') + '</span>';
  }
  function rater(kw, field, val) {
    let h = '<div class="rate">';
    for (let i = 1; i <= 5; i++)
      h += `<b class="${val === i ? 'on' : ''}" data-kw="${esc(kw)}" data-f="${field}" data-v="${i}">${i}</b>`;
    return h + '</div>';
  }

  const COLS = [
    { k: 'keyword', t: 'Keyword', cls: 'kw' },
    { k: 'demand', t: 'Demand', cls: 'num', fmt: v => v == null ? na() : dot(demandColor(v)) + v.toFixed(1) },
    { k: 'demandConfidence', t: 'Conf.', fmt: v => `<span class="chip">${(v || 'UNKNOWN').slice(0, 3)}</span>` },
    { k: 'ladder', t: 'Top-10 ratings, in rank order', val: r => r.ladder ? r.ladder.length : 0, fmt: (v, r) => ladder(r) },
    { k: 'entryBar', t: 'Entry bar', cls: 'num',
      fmt: (v, r) => v == null ? na() : `<span title="25th pct; lowest on page: ${r.entryBarMin}">${abbr(v)}</span>` },
    { k: 'rankEvidence', t: 'Small can rank', cls: 'num', fmt: v => v == null ? na() : dot(rankColor(v)) + v.toFixed(2) },
    { k: 'bestPosSmall', t: 'Best small pos', cls: 'num', fmt: v => v == null ? na('No app below the field median') : '#' + v },
    { k: 'medianTop10Ratings', t: 'Median', cls: 'num', fmt: v => v == null ? na() : abbr(v) },
    { k: 'top10Under500', t: '<500', cls: 'num', fmt: v => v == null ? na() : `${v}/10` },
    { k: 'dominant', t: 'Dominant (info only)',
      fmt: v => v ? `<span class="na" style="font-size:11.5px">${esc(v)}</span>` : '<span class="na">none</span>' },
    { k: 'smallRisers', t: 'Rising', cls: 'num', val: r => r.researched ? risersFor(r) : null,
      fmt: (v, r) => { const n = r.researched ? risersFor(r) : null;
        return n == null ? na() : (n > 0 ? dot('g') + n : '<span class="na">0</span>'); } },
    { k: 'productFit', t: 'Fit', fmt: (v, r) => rater(r.keyword, 'productFit', v) },
    { k: 'commercialIntent', t: 'Intent', fmt: (v, r) => rater(r.keyword, 'commercialIntent', v) },
    { k: 'opportunity', t: 'Opportunity', cls: 'num opp',
      fmt: (v, r) => v == null ? na(r.opportunityReason) : dot(oppColor(v)) + v },
  ];

  function rows() {
    const f = ($('#filter').value || '').trim().toLowerCase(), only = $('#only').value;
    return Object.keys(DB.keywords).map(A.row).filter(r => {
      if (f && !r.keyword.includes(f)) return false;
      if (only === 'done' && !r.researched) return false;
      if (only === 'todo' && r.researched) return false;
      if (only === 'scored' && r.opportunity == null) return false;
      return true;
    }).sort((a, b) => {
      const col = COLS.find(c => c.k === sortKey);
      let x = col && col.val ? col.val(a) : a[sortKey];
      let y = col && col.val ? col.val(b) : b[sortKey];
      if (typeof x === 'string' || typeof y === 'string')
        return String(x ?? '').localeCompare(String(y ?? '')) * sortDir;
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (x - y) * sortDir;
    });
  }

  function render() {
    $('#head').innerHTML = COLS.map(c => {
      const ar = sortKey === c.k ? `<span class="ar">${sortDir > 0 ? '▲' : '▼'}</span>` : '';
      return `<th data-k="${c.k}">${c.t} ${ar}</th>`;
    }).join('');
    $('#head').querySelectorAll('th').forEach(th => th.onclick = () => {
      const k = th.dataset.k;
      if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = (k === 'keyword') ? 1 : -1; }
      render();
    });
    const rs = rows();
    $('#empty').style.display = rs.length ? 'none' : 'block';
    $('#rows').innerHTML = rs.map(r => '<tr>' + COLS.map(c => {
      const v = c.val ? c.val(r) : r[c.k];
      const inner = c.fmt ? c.fmt(v, r) : (v == null ? na() : esc(v));
      return `<td class="${c.cls || ''}" ${c.cls === 'kw' ? `data-open="${esc(r.keyword)}"` : ''}>${inner}</td>`;
    }).join('') + '</tr>').join('');

    $('#rows').querySelectorAll('[data-open]').forEach(td => td.onclick = ev => {
      if (ev.shiftKey) {
        const kw = td.dataset.open;
        if (confirm(`Delete "${kw}"?`)) {
          delete DB.keywords[kw]; delete DB.results[kw]; A.save(); render();
        }
        return;
      }
      openDetail(td.dataset.open);
    });
    $('#rows').querySelectorAll('.rate b').forEach(b => b.onclick = ev => {
      ev.stopPropagation();
      const cur = DB.keywords[b.dataset.kw][b.dataset.f];
      DB.keywords[b.dataset.kw][b.dataset.f] = cur === +b.dataset.v ? null : +b.dataset.v;
      A.save(); render();
    });
    A.save();
  }
  window.render = render;
  window.openDetail = openDetail;

  function openDetail(kw) {
    const res = DB.results[kw];
    $('#overlay').classList.add('open');
    if (!res || (res.error && !(res.apps || []).length)) {
      $('#sheet').innerHTML = `<button class="close" onclick="closeDetail()">Close</button>
        <h2>${esc(kw)}</h2><div class="note">${esc((res && res.error) || 'Not researched yet.')}</div>`;
      return;
    }
    const meta = DB.keywords[kw] || {};
    const c = res.competition || {}, pen = c.penetration || {}, str = c.strength || {};
    const dem = res.demand || {}, tr = res.traction || {};
    const opp = S.opportunity(dem, c, meta.productFit, meta.commercialIntent, res.apps);
    const est = tr.estimatedDownloads;

    const demandCard = `<div class="card">
      <div class="kv">
        <div><span>Demand band</span><b>${dem.score == null ? 'UNKNOWN' : dem.score.toFixed(1) + ' / 5'}</b></div>
        <div><span>Confidence</span><b>${esc(dem.confidence)}</b></div>
        <div><span>Search volume</span><b class="na">UNAVAILABLE</b></div>
      </div>
      <div class="why"><b>Signal:</b> ${esc(dem.signal)}<br><b>Why:</b> ${esc(dem.why)}<br>
        <b>Volume:</b> ${esc(dem.searchVolumeNote)}</div></div>`;

    const oppBars = opp.factors ? Object.entries(opp.factors).map(([k, f]) => `
      <div class="brow"><span>${esc(k.replace(/([A-Z])/g, ' $1').toLowerCase())}
        <span class="chip">${f.kind}</span>${f.role === 'modifier' ? ' <span class="chip">modifier</span>' : ''}</span>
        <div class="track"><div class="fill ${f.kind === 'objective' ? 'obj' : ''}"
          style="width:${Math.min(100, Math.max(0, f.norm * 100))}%"></div></div>
        <span class="num">${f.raw == null ? '—' : f.raw}</span></div>
      ${f.note ? `<div class="why" style="margin:1px 0 5px 130px;font-size:11.5px">${esc(f.note)}</div>` : ''}`).join('') : '';

    const oppCard = `<div class="card">
      <div class="kv">
        <div><span>Opportunity</span><b style="font-size:19px">${opp.score ?? '—'}</b></div>
        <div><span>Verdict</span><b>${opp.band ? `<span class="chip">${opp.band}</span>` : '<span class="na">withheld</span>'}</b></div>
        <div><span>Demand confidence</span><b>${esc(opp.confidence || dem.confidence)}</b></div>
      </div>
      ${opp.reason ? `<div class="why">${esc(opp.reason)}</div>` : ''}
      ${opp.bandGate ? `<div class="why" style="color:var(--yellow)">⚠ ${esc(opp.bandGate)}</div>` : ''}
      <div class="bars">${oppBars}</div>
      ${opp.formula ? `<pre>${esc(opp.formula)}\n\nFour GATES multiply; listing weakness is a MODIFIER (0.85-1.25).\n"Small apps can rank" comes from the observed distribution - a large\nincumbent does NOT reduce it. ${esc(opp.caveat)}</pre>` : ''}</div>`;

    const distCard = `<div class="card">
      <div class="why" style="margin:0 0 10px"><b>This is the evidence.</b> Rating count is a proxy
        for competitor <b>traction</b> — not keyword difficulty, not downloads, not search demand.</div>
      <table style="font-size:12.5px"><thead><tr><th>Pos</th><th>App</th><th class="num">Ratings</th>
        <th class="num">Stars</th><th class="num">Age</th><th class="num">Updated</th></tr></thead>
      <tbody>${res.apps.slice(0, 10).map(a => {
        const sm = a.ratingCount != null && a.ratingCount < 1000;
        return `<tr><td class="num">#${a.position}</td>
          <td>${esc(a.name)}${sm ? ' <span class="chip" style="color:var(--green)">SMALL</span>' : ''}</td>
          <td class="num" style="${sm ? 'color:var(--green);font-weight:650' : ''}">${a.ratingCount != null ? a.ratingCount.toLocaleString() : '—'}</td>
          <td class="num">${a.rating != null ? a.rating.toFixed(1) : '—'}</td>
          <td class="num">${a.ageDays != null ? (a.ageDays / 365).toFixed(1) + 'y' : '—'}</td>
          <td class="num">${a.daysSinceUpdate != null ? a.daysSinceUpdate + 'd' : '—'}</td></tr>`;
      }).join('')}</tbody></table>
      <div class="kv" style="margin-top:13px">
        <div><span>Entry bar (25th pct)</span><b>${pen.entryBarP25 != null ? Math.round(pen.entryBarP25).toLocaleString() : '—'}</b></div>
        <div><span>Lowest that still ranks</span><b>${pen.entryBarMin != null ? pen.entryBarMin.toLocaleString() : '—'}</b></div>
        <div><span>Field median</span><b>${pen.fieldMedian != null ? Math.round(pen.fieldMedian).toLocaleString() : '—'}</b></div>
        <div><span>Average</span><b>${c.avgRatingCount != null ? Math.round(c.avgRatingCount).toLocaleString() : '—'}</b></div>
        <div><span>Under 100</span><b>${c.under100 ?? '—'}</b></div>
        <div><span>Under 500</span><b>${c.under500 ?? '—'}</b></div>
        <div><span>Under 1,000</span><b>${c.under1000 ?? '—'}</b></div>
        <div><span>Over 10,000</span><b>${c.over10000 ?? '—'}</b></div>
        <div><span>Positions under 1,000</span><b>${(pen.positionsUnder1000 || []).map(x => '#' + x).join(' ') || '<span class="na">none</span>'}</b></div>
        <div><span>Best pos below median</span><b>${pen.bestPositionBelowMedian ? '#' + pen.bestPositionBelowMedian : '—'}</b></div>
        <div><span>Under-1,000 in top 5</span><b>${pen.inTop5Under1000 ?? '—'}</b></div>
        <div><span>Size↔rank correlation</span><b>${pen.sizeRankCorrelation ?? '—'}</b></div>
      </div>
      ${c.dominantIncumbent ? `<div class="why"><b>Dominant incumbent:</b> ${esc(c.dominantIncumbent.name)}
        at ${c.dominantIncumbent.ratingCount.toLocaleString()} ratings — ${c.dominantIncumbent.multipleOfFieldMedian}×
        the rest of the field. <b>This does not reduce the score.</b></div>` : '<div class="why">No dominant incumbent flagged.</div>'}
      <div class="bars">${str.components ? Object.entries(str.components).map(([k, v]) => `
        <div class="brow"><span>${esc(k.replace(/([A-Z])/g, ' $1').toLowerCase())}</span>
        <div class="track"><div class="fill obj" style="width:${v / 25 * 100}%"></div></div>
        <span class="num">${v}</span></div>`).join('') : ''}</div>
      <div class="why">Competitor strength ${str.score ?? '—'}/100 (${str.band || '—'}) — context only,
        not part of the opportunity score.</div></div>`;

    const tractionCard = `<div class="card">
      <div class="kv">
        <div><span>Median ratings/day</span><b>${tr.medianCurrentRatingsPerDay ?? tr.medianLifetimeRatingsPerDay ?? '—'}</b></div>
        <div><span>Basis</span><b><span class="chip">${tr.hasTimeSeries ? 'MEASURED' : 'LIFETIME AVG'}</span></b></div>
        <div><span>Small apps rising</span><b>${tr.smallRiserCount ?? '—'}</b></div>
        <div><span>Accelerating now</span><b>${tr.acceleratingCount ?? '<span class="na">needs 2 runs</span>'}</b></div>
      </div>
      ${!tr.hasTimeSeries ? `<div class="why">Only one observation so far, so these are lifetime
        averages. Re-run in a few days and measured velocity replaces them.</div>` : ''}
      ${(tr.growthRanking || []).length ? `<div style="margin-top:13px">
        <b style="font-size:11px;letter-spacing:.05em;color:var(--muted)">GROWTH LEADERBOARD — every app, any size</b>
        <table style="margin-top:7px;font-size:12.5px"><thead><tr><th>App</th><th class="num">Ratings</th>
          <th class="num">Per day</th><th class="num">Momentum</th></tr></thead>
        <tbody>${tr.growthRanking.map(g => `<tr>
          <td>${esc(g.name)}${g.accelerating ? ' <span class="chip">ACCEL</span>' : ''}</td>
          <td class="num">${g.ratingCount != null ? g.ratingCount.toLocaleString() : '—'}</td>
          <td class="num">${g.ratingsPerDay}</td>
          <td class="num">${g.momentum != null ? g.momentum + '×' : '<span class="na">—</span>'}</td></tr>`).join('')}</tbody></table></div>` : ''}
      ${est ? `<div class="card" style="border-style:dashed;margin:13px 0 0;background:transparent">
        <div class="kv">
          <div><span>Est. downloads/day</span><b>${est.perDayLow.toLocaleString()} – ${est.perDayHigh.toLocaleString()}</b></div>
          <div><span>Est. downloads/month</span><b>${est.perMonthLow.toLocaleString()} – ${est.perMonthHigh.toLocaleString()}</b></div>
          <div><span>Status</span><b><span class="chip">${est.calibrationPairs ? 'CALIBRATED' : 'UNCALIBRATED'}</span></b></div>
        </div>
        <div class="why" style="color:var(--yellow)">⚠ <b>ESTIMATE — the weakest number here.</b>
          ${esc(est.health)}. ${esc(est.assumption)}.</div>
        <div class="why">${esc(est.warning)}</div></div>` : ''}
      <div class="why" style="margin-top:10px"><b>Revenue is not estimated anywhere in this tool.</b>
        It would need downloads × free-to-paid conversion × retention, and conversion is
        unobservable for any app but your own.</div></div>`;

    const appsCard = `<div class="card">
      <div class="why" style="margin:0 0 8px">${esc((res.meta || {}).rankingCaveat)}
        Fetched ${esc((res.meta || {}).fetchedAt)}.</div>
      ${res.apps.map(a => {
        const ps = S.productSignals(a);
        return `<div class="app">
          <img src="${esc(a.icon || '')}" alt="" onerror="this.style.visibility='hidden'">
          <div class="m"><div class="t">${a.position}. ${esc(a.name)}
            ${a.exactMatchInTitle ? '<span class="chip">EXACT IN TITLE</span>' : ''}</div>
            <div class="d">${esc(a.developer)} · ${esc(a.category)} ·
              ${a.rating != null ? a.rating.toFixed(1) + '★' : 'no rating'} ·
              ${a.ratingCount != null ? a.ratingCount.toLocaleString() + ' ratings' : '<span class="na">n/a</span>'} ·
              ${esc(a.formattedPrice)} ·
              ${a.ageDays != null ? (a.ageDays / 365).toFixed(1) + 'y old' : 'age unknown'} ·
              ${a.daysSinceUpdate != null ? 'updated ' + a.daysSinceUpdate + 'd ago' : ''}</div>
            ${ps.weaknessFlags.map(f => `<div class="flag">▸ ${esc(f)}</div>`).join('')}
            <div style="margin-top:6px">
              ${a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">Open listing ↗</a>` : ''}
              ${a.trackId ? ` · <a href="#" onclick="loadReviews('${esc(kw)}',${a.trackId},this);return false">Analyse reviews</a>` : ''}
              · <span class="na">subtitle: not in public API</span></div>
            <div class="revbox"></div></div></div>`;
      }).join('')}</div>`;

    $('#sheet').innerHTML = `<button class="close" onclick="closeDetail()">Close</button>
      <h2>${esc(kw)}</h2><div class="sub">United States · Apple App Store (iPhone)</div>
      <div class="step"><h3>Demand</h3>${demandCard}</div>
      <div class="step"><h3>Opportunity summary</h3>${oppCard}</div>
      <div class="step"><h3>Top-10 distribution — can small apps rank?</h3>${distCard}</div>
      <div class="step"><h3>Traction — who is actually growing</h3>${tractionCard}</div>
      <div class="step"><h3>Top apps (${res.apps.length})</h3>${appsCard}</div>`;
    window.scrollTo(0, 0);
  }

  window.closeDetail = () => { $('#overlay').classList.remove('open'); render(); };

  window.loadReviews = async function (kw, trackId, el) {
    const box = el.closest('.m').querySelector('.revbox');
    // 3 pages through the 3.5s rate limiter is ~10s; say so rather than
    // leaving a spinner that looks hung.
    box.innerHTML = '<div class="na" style="padding:8px 0">Fetching up to 150 recent reviews… ' +
      'this takes about 10 seconds (Apple rate limit).</div>';
    try {
      const all = [];
      for (let page = 1; page <= 3; page++) {
        const data = await A.fetchCached(A.reviewUrl(trackId, page));
        let entries = ((data || {}).feed || {}).entry || [];
        if (!Array.isArray(entries)) entries = [entries];
        entries.forEach(e => {
          if (!e || !e['im:rating']) return;
          all.push({ title: (e.title || {}).label, body: (e.content || {}).label,
            rating: parseInt((e['im:rating'] || {}).label || 0, 10),
            version: (e['im:version'] || {}).label });
        });
        if (entries.length < 2) break;
      }
      if (!all.length) { box.innerHTML = '<div class="na" style="padding:8px 0">No US reviews returned.</div>'; return; }
      const a = S.mineReviews(all);
      box.innerHTML = `<div class="card" style="margin-top:9px">
        <div class="kv"><div><span>Reviews analysed</span><b>${a.reviewsAnalysed}</b></div>
          <div><span>1-2 star share</span><b>${a.negativeShare != null ? a.negativeShare + '%' : '—'}</b></div></div>
        ${Object.entries(a.themes).filter(([, v]) => v.count).map(([name, v]) => `
          <div style="margin-top:11px"><b style="font-size:11px;letter-spacing:.05em;color:var(--muted)">${esc(name)} — ${v.count}</b>
          ${v.samples.map(s => `<div class="why" style="margin-top:5px">${s.rating}★
            <span class="chip">matched "${esc(s.matched)}"</span> ${esc(s.excerpt)}</div>`).join('')}</div>`).join('')
          || '<div class="na">No themed matches.</div>'}
        <div class="why" style="margin-top:12px"><b>Method:</b> ${esc(a.method)}</div>
        <div class="why"><b>Coverage:</b> ${esc(a.coverageCaveat)}</div></div>`;
    } catch (err) {
      box.innerHTML = `<div class="na" style="padding:8px 0">${esc(err.message || err)}</div>`;
    }
  };

  /* ---- exports --------------------------------------------------------- */
  const CSV_COLS = [['keyword','KEYWORD'],['demand','DEMAND_0_5'],['demandConfidence','DEMAND_CONFIDENCE'],
    ['demandSignal','DEMAND_SIGNAL'],['competition','COMPETITOR_STRENGTH_0_100'],
    ['medianTop10Ratings','MEDIAN_TOP10_RATINGS'],['avgRatingCount','AVG_TOP10_RATINGS'],
    ['entryBar','ENTRY_BAR_P25_RATINGS'],['entryBarMin','ENTRY_BAR_MIN_RATINGS'],
    ['under100','TOP10_UNDER_100'],['top10Under500','TOP10_UNDER_500'],['pctUnder500','PCT_UNDER_500'],
    ['under1000','TOP10_UNDER_1000'],['over10000','TOP10_OVER_10000'],
    ['bestPosSmall','BEST_POSITION_BELOW_MEDIAN'],['bestPosUnder1000','BEST_POSITION_UNDER_1000'],
    ['rankEvidence','SMALL_APPS_CAN_RANK_0_1'],['avgStars','AVG_STARS'],['dominant','DOMINANT_COMPETITOR'],
    ['tractionPerDay','MEDIAN_TOP10_RATINGS_PER_DAY_OBSERVED'],['smallRisers','SMALL_APPS_GAINING_TRACTION'],
    ['productFit','PRODUCT_FIT_1_5'],['commercialIntent','COMMERCIAL_INTENT_1_5'],
    ['opportunity','OPPORTUNITY_0_100'],['opportunityBand','OPPORTUNITY_BAND'],['fetchedAt','FETCHED_AT']];

  function download(name, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
  }
  const q = v => { const s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

  window.exportCsv = () => {
    const lines = [CSV_COLS.map(c => c[1]).join(',')];
    lines.push(q('# search volume, keyword difficulty and revenue are UNAVAILABLE and deliberately absent')
      + ','.repeat(CSV_COLS.length - 1));
    Object.keys(DB.keywords).forEach(kw => {
      const r = A.row(kw);
      lines.push(CSV_COLS.map(([k]) => {
        const v = r[k];
        if (v != null) return q(v);
        if (k === 'dominant' && r.researched) return 'NONE DETECTED';
        if (!r.researched) return 'NOT RESEARCHED';
        return 'UNAVAILABLE';
      }).join(','));
    });
    download('app-opportunity-scout.csv', lines.join('\n'), 'text/csv');
  };
  window.exportJson = () => download('app-opportunity-scout.json', JSON.stringify({
    tool: 'App Opportunity Scout (browser build)', exportedAt: new Date().toISOString(),
    market: 'us', store: 'Apple App Store / iPhone',
    unavailableMetrics: ['keyword search volume', 'keyword difficulty',
      'revenue (needs unobservable free-to-paid conversion)', 'true App Store SERP rank'],
    modelledMetrics: { ratingVelocity: 'OBSERVED - Apple rating counts sampled across runs.',
      downloads: 'ESTIMATED RANGE ONLY - order of magnitude, not a measurement.' },
    buildLimitation: 'Apple autocomplete needs a request header JSONP cannot set, so demand ' +
      'confidence tops out at LOW in the browser build.',
    keywords: DB.keywords, rows: Object.keys(DB.keywords).map(A.row), results: DB.results
  }, null, 1), 'application/json');
})();
