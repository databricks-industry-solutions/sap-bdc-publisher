// Shared browser helpers for the Publish and Dashboard pages.
// Plain script (no modules, no build step). Everything hangs off window.BDC.

(function () {
  const WH_KEY = 'data-sharing:warehouseId';
  const PENDING_MAX_MS = 180_000;

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function stripRefresh(path, body) {
    const p = path.replace(/([?&])refresh=[^&]*(&|$)/, (m, a, b) => (b ? a : '')).replace(/[?&]$/, '');
    let b = body;
    if (b && typeof b === 'object' && 'refresh' in b) { b = { ...b }; delete b.refresh; }
    return [p, b];
  }

  const TRANSIENT = new Set([502, 503, 504]);

  // fetch wrapper.
  // - 202 {pending:true}: the server is still working within its request
  //   budget. Re-send the same request (it joins the work in flight).
  // - 502/503/504 or a network error: one automatic retry for GETs, then a
  //   readable error with err.transient = true so the caller can offer Retry.
  async function api(method, path, body) {
    const started = Date.now();
    let attempt = 0;
    let curPath = path;
    let curBody = body;
    for (;;) {
      const opts = { method, headers: { Accept: 'application/json' }, credentials: 'include' };
      if (curBody) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(curBody); }
      let res;
      try {
        res = await fetch(curPath, opts);
      } catch (netErr) {
        if (method === 'GET' && attempt === 0) { attempt += 1; await sleep(1500); continue; }
        const err = new Error('The app could not be reached. Check your connection and try again.');
        err.transient = true; err.cause = netErr; throw err;
      }
      const txt = await res.text();
      let data = null;
      try { data = txt ? JSON.parse(txt) : null; } catch { data = { raw: txt }; }
      if (res.status === 202 && data && data.pending) {
        if (Date.now() - started > PENDING_MAX_MS) {
          const err = new Error('This is taking longer than expected. The warehouse may still be starting. Try again in a minute.');
          err.transient = true; err.status = 202; throw err;
        }
        [curPath, curBody] = stripRefresh(curPath, curBody);
        await sleep(data.retryAfterMs || 1500);
        continue;
      }
      if (TRANSIENT.has(res.status)) {
        if (method === 'GET' && attempt === 0) { attempt += 1; await sleep(1500); continue; }
        const fromApp = data && (data.message || data.error);
        const err = new Error(fromApp ||
          `The app didn't answer in time (HTTP ${res.status}). This is usually temporary, for example while the app restarts or a warehouse starts.`);
        err.transient = true; err.status = res.status; err.payload = data; throw err;
      }
      if (!res.ok) {
        const err = new Error((data && (data.message || data.error)) || ('HTTP ' + res.status));
        err.payload = data; err.status = res.status; throw err;
      }
      return data;
    }
  }

  // Render an error box. If retryId is given and the error is transient (or
  // always, with force), adds a Retry button with that id.
  function errorBox(prefix, e, retryId) {
    const retry = retryId ? ` <button type="button" class="btn secondary btn-sm" id="${escHtml(retryId)}">Retry</button>` : '';
    return `<div class="msg ${e && e.transient ? 'warn' : 'err'}"><strong>${escHtml(prefix)}</strong> ${escHtml(e && e.message)}${retry}</div>`;
  }

  function initials(name) {
    return (name || '?').split(/[\s@.]+/).map((p) => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
  }

  async function renderUserBadge(elId) {
    try {
      const me = await api('GET', '/api/me');
      const name = me.displayName || me.userName || '';
      const email = me.email || me.userName || '';
      document.getElementById(elId).innerHTML =
        `<div class="user-avatar">${escHtml(initials(name))}</div>` +
        `<div><div>${escHtml(name)}</div><div class="user-email">${escHtml(email)}</div></div>`;
      return me;
    } catch (e) {
      document.getElementById(elId).innerHTML = '<span class="muted">Sign-in error</span>';
      return null;
    }
  }

  // Warehouse: auto-pick (saved choice, else the server's ranking: running
  // serverless, any serverless, smallest classic) and start it if stopped.
  // onState(w) is called with every state update.
  async function listWarehouses() {
    return api('GET', '/api/warehouses');
  }

  function pickWarehouse(list) {
    const saved = localStorage.getItem(WH_KEY);
    if (saved && list.warehouses.some((w) => w.id === saved)) return saved;
    return list.defaultId;
  }

  async function ensureWarehouseRunning(id, onState) {
    localStorage.setItem(WH_KEY, id);
    let w = await api('POST', '/api/warehouses/' + encodeURIComponent(id) + '/start');
    onState && onState(w);
    const t0 = Date.now();
    while (w.state !== 'RUNNING') {
      const waited = Date.now() - t0;
      if (['DELETED', 'DELETING'].includes(w.state) || (['STOPPED', 'STOPPING'].includes(w.state) && waited > 10_000)) {
        throw new Error(`Warehouse ${w.name} is ${w.state}. Pick another one.`);
      }
      if (waited > 180_000) throw Object.assign(new Error(`Warehouse ${w.name} is taking long to start. Try again shortly.`), { transient: true });
      await sleep(2000);
      w = await api('GET', '/api/warehouses/' + encodeURIComponent(id));
      onState && onState(w);
    }
    return w;
  }

  function stateBadge(state) {
    return `<span class="badge ${escHtml(String(state).toLowerCase())}">${escHtml(state)}</span>`;
  }

  // "Compute: <name> (change)" line. container: element. onReady(id) fires
  // once the chosen warehouse is RUNNING (and again after a change).
  async function mountCompute(container, onReady) {
    container.innerHTML = '<span class="muted"><span class="loading"></span> Finding a SQL warehouse…</span>';
    let list;
    try {
      list = await listWarehouses();
    } catch (e) {
      container.innerHTML = errorBox('Could not list warehouses:', e, 'wh-retry');
      const b = document.getElementById('wh-retry'); if (b) b.onclick = () => mountCompute(container, onReady);
      return;
    }
    if (!list.warehouses.length) {
      container.innerHTML = '<div class="msg err">You don\'t have CAN USE on any SQL warehouse. Ask a workspace admin for access, then refresh.</div>';
      return;
    }
    let currentId = pickWarehouse(list);
    async function start(id) {
      currentId = id;
      const w0 = list.warehouses.find((w) => w.id === id) || { name: id, state: '' };
      const paint = (w) => {
        container.innerHTML =
          `<span class="compute">Compute: <strong>${escHtml(w.name || w0.name)}</strong> ${stateBadge(w.state || w0.state)}` +
          (w.state && w.state !== 'RUNNING' ? ' <span class="muted">starting…</span>' : '') +
          ` <a href="#" id="wh-change">change</a></span>` +
          `<span id="wh-picker" hidden> <select id="wh-select" class="inline-select">` +
          list.warehouses.map((x) => `<option value="${escHtml(x.id)}"${x.id === id ? ' selected' : ''}>${escHtml(x.name)}${x.serverless ? ' (serverless)' : ''} [${escHtml(x.state)}]</option>`).join('') +
          `</select></span>`;
        document.getElementById('wh-change').onclick = (ev) => {
          ev.preventDefault();
          document.getElementById('wh-picker').hidden = false;
          const sel = document.getElementById('wh-select');
          sel.focus();
          sel.onchange = () => start(sel.value);
        };
      };
      paint(w0);
      try {
        await ensureWarehouseRunning(id, paint);
        onReady(id);
      } catch (e) {
        container.innerHTML += errorBox('Warehouse:', e, 'wh-retry');
        const b = document.getElementById('wh-retry'); if (b) b.onclick = () => start(currentId);
      }
    }
    await start(currentId);
  }

  function fmtDate(v) {
    if (!v) return '—';
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return escHtml(v);
    return d.toISOString().slice(0, 10);
  }

  function fmtAgo(v) {
    if (!v) return '—';
    const t = Date.parse(v);
    if (Number.isNaN(t)) return '—';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }

  function fmtNum(n) {
    if (n == null) return '—';
    return Number(n).toLocaleString('en-US');
  }

  function fmtBytes(n) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let i = 0; let v = Number(n);
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
    return (v >= 10 || i === 0 ? v.toFixed(0) : v.toFixed(1)) + ' ' + u[i];
  }

  window.BDC = {
    api, escHtml, errorBox, renderUserBadge, mountCompute, stateBadge,
    fmtDate, fmtAgo, fmtNum, fmtBytes, sleep,
  };
})();
