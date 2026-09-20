/* Event wiring + boot. Kept last so every helper is defined. */
(function () {
  'use strict';
  const A = window.ScoutApp, $ = s => document.querySelector(s);
  A.load();

  $('#overlay').onclick = e => { if (e.target.id === 'overlay') window.closeDetail(); };
  document.addEventListener('keydown', e => { if (e.key === 'Escape') window.closeDetail(); });
  $('#filter').oninput = window.render;
  $('#only').onchange = window.render;
  $('#cap').onchange = () => {
    try { localStorage.setItem('scout.riserCap', $('#cap').value); } catch (e) {}
    window.render();
  };
  try { const v = localStorage.getItem('scout.riserCap'); if (v) $('#cap').value = v; } catch (e) {}

  $('#add').onclick = () => {
    const raw = $('#newkw').value.trim();
    if (!raw) return;
    raw.split(/[\n,]/).map(s => s.trim().toLowerCase().replace(/\s+/g, ' ')).filter(Boolean)
      .forEach(k => { if (!A.DB.keywords[k]) A.DB.keywords[k] = { productFit: null, commercialIntent: null }; });
    $('#newkw').value = ''; A.save(); window.render();
  };
  $('#newkw').onkeydown = e => { if (e.key === 'Enter') $('#add').click(); };

  $('#run').onclick = () => {
    if (A.running) return;
    const f = ($('#filter').value || '').trim().toLowerCase();
    const list = Object.keys(A.DB.keywords).filter(k => !f || k.includes(f));
    if (!list.length) return alert('No keywords to research.');
    const mins = Math.ceil(list.length * 3.5 / 60);
    if (!confirm(`Research ${list.length} keyword${list.length > 1 ? 's' : ''}?\n\n` +
      `Apple allows about 20 requests a minute, so this takes roughly ${mins} minute` +
      `${mins > 1 ? 's' : ''}. Already-cached keywords return instantly.\n\n` +
      `Keep this tab open while it runs.`)) return;
    A.research(list, false);
  };

  $('#csv').onclick = window.exportCsv;
  $('#jsonx').onclick = window.exportJson;
  $('#reset').onclick = () => {
    if (!confirm('Clear ALL keywords, results and history in this browser?\n\n' +
      'This cannot be undone. Export first if you want to keep it.')) return;
    try { localStorage.removeItem('scout.v1'); } catch (e) {}
    location.reload();
  };

  // file:// pages can still JSONP, but warn if opened over plain http where
  // browsers block the https script as mixed content.
  if (location.protocol === 'http:' && location.hostname !== 'localhost') {
    const n = document.createElement('div');
    n.className = 'note';
    n.style.borderLeftColor = 'var(--red)';
    n.innerHTML = '<b>Serve this over HTTPS.</b> On plain http:// the browser blocks Apple\'s ' +
                  'https script as mixed content and no data will load.';
    $('#banner').parentNode.insertBefore(n, $('#banner'));
  }
  window.render();
})();
