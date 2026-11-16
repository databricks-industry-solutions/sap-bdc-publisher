// Request budget + short-lived cache for slow, idempotent work.
//
// The Databricks Apps proxy cuts requests that run too long and answers with
// a bare 502. A cold warehouse or a slow information_schema query can take
// longer than that. `budgeted` runs the work once per key, answers within
// BUDGET_MS, and if the work is still running replies 202 {pending: true}.
// The browser re-sends the same request; the second call attaches to the
// work already in flight instead of starting it again.

const BUDGET_MS = Number(process.env.BDC_REQUEST_BUDGET_MS) || 25_000;
const SETTLED_KEEP_MS = 60_000;

const inflight = new Map(); // key -> Promise
const settled = new Map();  // key -> { ok, value, error, at }

const PENDING = Symbol('pending');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function sweep() {
  const now = Date.now();
  for (const [k, v] of settled) if (now - v.at > Math.max(SETTLED_KEEP_MS, v.ttlMs || 0)) settled.delete(k);
}

function start(key, fn, ttlMs) {
  const p = (async () => fn())();
  inflight.set(key, p);
  p.then(
    (value) => { settled.set(key, { ok: true, value, at: Date.now(), ttlMs }); },
    (error) => { settled.set(key, { ok: false, error, at: Date.now(), ttlMs: 0 }); },
  ).finally(() => { inflight.delete(key); });
  return p;
}

// fn: () => Promise<json>. ttlMs: how long a successful result is served from
// cache. refresh: skip the cache (but still join work already in flight).
export async function budgeted(req, res, next, key, fn, { ttlMs = 30_000, refresh = false, budgetMs = BUDGET_MS } = {}) {
  try {
    sweep();
    const hit = settled.get(key);
    if (hit) {
      const age = Date.now() - hit.at;
      if (!hit.ok) {
        // Hand the error to the poller exactly once, then forget it.
        settled.delete(key);
        throw hit.error;
      }
      if (!refresh && age < ttlMs) return res.json({ ...hit.value, cachedAgeMs: age });
      settled.delete(key);
    }
    const p = inflight.get(key) || start(key, fn, ttlMs);
    const timeout = sleep(budgetMs).then(() => PENDING);
    let out;
    try { out = await Promise.race([p, timeout]); }
    catch (e) { settled.delete(key); throw e; } // answered now, don't replay it
    if (out === PENDING) {
      res.status(202).json({ pending: true, retryAfterMs: 1500 });
      return;
    }
    res.json(out);
  } catch (err) { next(err); }
}

export function invalidate(prefix) {
  for (const k of settled.keys()) if (k.startsWith(prefix)) settled.delete(k);
}

// Run fn over items with at most `limit` in flight. Used anywhere a per-item
// SQL statement is still unavoidable, so a share with 200 tables can't open
// 200 statements at once.
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
