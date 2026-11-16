// GET /api/dashboard?warehouseId=…&window=7d|30d|90d[&all=true][&refresh=1]
//
// One endpoint for every Dashboard widget, in three tiers:
//   1. Inventory (user OBO, no extra privileges): shares in BDC, tables,
//      tables without a UC primary key, source tables changed since publish.
//   2. Activity log (if configured): success rate, activity over time,
//      failures by reason, last publish per share, pending revokes.
//   3. SAP reads (opt-in): Delta Sharing query events from
//      system.access.audit, read by the app SP. Results are limited to
//      shares the caller sees in tier 1.
// A tier that isn't available returns { available: false, enable: {...} }
// with the exact grant, never an error.

import { Router } from 'express';
import { getShareSourceSummary, spSqlQuery, sqlQuery, getUserGroupsByEmail } from '../dbx.js';
import { loadOverview } from './shares.js';
import { budgeted } from '../lib/budget.js';
import { userKey } from '../lib/identity.js';
import { getActivityTable } from '../config.js';
import { getActivityColumns, noteWarehouse, V2_COLUMNS } from '../activity.js';
import { getPendingRevokes } from '../runs.js';
import { requireRequestUser } from '../auth.js';

const router = Router();
const WINDOWS = { '7d': 7, '30d': 30, '90d': 90 };
const UNUSED_AFTER_DAYS = 14;

const FAILURE_BUCKETS = {
  secret_scope_missing: { label: 'Secret scope missing', faq: '/faq.html#secret-scope' },
  missing_sp_grant: { label: 'App SP missing table access', faq: '/faq.html#sp-grants' },
  privilege_denied: { label: 'Privilege denied', faq: '/faq.html#privileges' },
  pk_missing: { label: 'Primary key missing', faq: '/faq.html#primary-keys' },
  object_not_found: { label: 'Object not found', faq: '/faq.html#troubleshooting' },
  grant_failed: { label: 'GRANT on share failed', faq: '/faq.html#privileges' },
  other: { label: 'Other', faq: '/faq.html#troubleshooting' },
};

function bucketFor(eventType, errorCode) {
  if (eventType === 'publish_grant_failed') return 'grant_failed';
  return FAILURE_BUCKETS[errorCode] ? errorCode : 'other';
}

async function isActivityAdmin(req, email) {
  const adminGroup = process.env.BDC_ACTIVITY_ADMIN_GROUP;
  if (!adminGroup) return false;
  const groups = await getUserGroupsByEmail(req, email).catch(() => []);
  return groups.includes(adminGroup);
}

function ts(v) { const t = v ? Date.parse(v) : NaN; return Number.isNaN(t) ? null : t; }

async function tier2(req, { warehouseId, days, userEmail, all }) {
  const table = await getActivityTable();
  if (!table) {
    return { available: false, reason: 'not_configured', enable: { text: 'Set up the activity log on the Activity page.', href: '/activity.html' } };
  }
  const params = [{ name: 'days', value: String(days * 2), type: 'INT' }];
  let userFilter = '';
  if (!all) {
    userFilter = 'AND lower(user_email) = lower(:user_email) ';
    params.push({ name: 'user_email', value: String(userEmail), type: 'STRING' });
  }
  // One read covers the window and the previous window (for deltas). Runs as
  // the user, like the Activity page.
  const rows = await sqlQuery(req, warehouseId,
    `SELECT event_time, event_type, user_email, share_name, recipient_name, run_id, error_code ` +
    `FROM ${table} WHERE event_time > current_timestamp() - make_interval(0, 0, 0, :days) ${userFilter}` +
    `AND event_type <> 'wizard_adopt_probe' ORDER BY event_time`, params);

  // Last successful publish per (share, connection), all time, for the
  // published-shares table and drift detection. Not limited to the window.
  // Same per-user rule as the Activity page.
  const lastRows = await sqlQuery(req, warehouseId,
    `SELECT share_name, recipient_name, max_by(user_email, event_time) AS by_user, max(event_time) AS at ` +
    `FROM ${table} WHERE event_type IN ('publish_job_succeeded', 'republish_job_succeeded') ` +
    `${userFilter}GROUP BY share_name, recipient_name`, params.filter((p) => p.name === 'user_email'));

  const now = Date.now();
  const windowStart = now - days * 86400_000;
  const cur = rows.filter((r) => ts(r.event_time) >= windowStart);
  const prev = rows.filter((r) => ts(r.event_time) < windowStart);

  const count = (list, types) => list.filter((r) => types.includes(r.event_type)).length;
  const ok = count(cur, ['publish_job_succeeded', 'republish_job_succeeded']);
  const failed = count(cur, ['publish_job_failed', 'republish_job_failed', 'publish_grant_failed']);
  const prevOk = count(prev, ['publish_job_succeeded', 'republish_job_succeeded']);
  const prevFailed = count(prev, ['publish_job_failed', 'republish_job_failed', 'publish_grant_failed']);

  // Daily buckets, oldest first.
  const daily = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now - i * 86400_000).toISOString().slice(0, 10);
    daily.push({ date: d, publishOk: 0, publishFailed: 0, unpublish: 0 });
  }
  const byDate = new Map(daily.map((d) => [d.date, d]));
  for (const r of cur) {
    const d = byDate.get(String(r.event_time).slice(0, 10));
    if (!d) continue;
    if (['publish_job_succeeded', 'republish_job_succeeded'].includes(r.event_type)) d.publishOk += 1;
    else if (['publish_job_failed', 'republish_job_failed', 'publish_grant_failed'].includes(r.event_type)) d.publishFailed += 1;
    else if (r.event_type === 'delete_finalized') d.unpublish += 1;
  }

  const failures = {};
  for (const r of cur) {
    if (!['publish_job_failed', 'republish_job_failed', 'publish_grant_failed', 'publish_preflight_failed'].includes(r.event_type)) continue;
    const b = r.event_type === 'publish_preflight_failed' ? 'preflight' : bucketFor(r.event_type, r.error_code);
    failures[b] = (failures[b] || 0) + 1;
  }
  const failuresByReason = Object.entries(failures)
    .map(([code, n]) => ({
      code, count: n,
      label: code === 'preflight' ? 'Stopped by pre-flight' : FAILURE_BUCKETS[code].label,
      faq: code === 'preflight' ? '/faq.html#preflight' : FAILURE_BUCKETS[code].faq,
    }))
    .sort((a, b) => b.count - a.count);

  // Last publish attempt per pair in the window: failed and not retried.
  const lastAttempt = new Map();
  for (const r of cur) {
    if (!['publish_job_succeeded', 'publish_job_failed', 'republish_job_succeeded', 'republish_job_failed', 'publish_grant_failed'].includes(r.event_type)) continue;
    lastAttempt.set(`${r.share_name}\0${r.recipient_name}`, r);
  }
  const failedNotRetried = Array.from(lastAttempt.values())
    .filter((r) => /failed$/.test(r.event_type))
    .map((r) => ({ shareName: r.share_name, recipientName: r.recipient_name, at: r.event_time, runId: r.run_id }));

  let topPublishers = null;
  if (all) {
    const m = new Map();
    for (const r of cur) {
      if (!['publish_submitted', 'republish_submitted'].includes(r.event_type)) continue;
      m.set(r.user_email, (m.get(r.user_email) || 0) + 1);
    }
    topPublishers = Array.from(m.entries()).map(([user, n]) => ({ user, count: n })).sort((a, b) => b.count - a.count).slice(0, 5);
  }

  let needsMigration = false;
  try {
    const cols = await getActivityColumns(table, warehouseId);
    needsMigration = V2_COLUMNS.some((c) => !cols.has(c.name));
  } catch { /* SP can't read: Activity page will show it */ }

  return {
    available: true,
    table,
    needsMigration,
    publishSuccess: {
      ok, failed,
      rate: ok + failed ? ok / (ok + failed) : null,
      prevRate: prevOk + prevFailed ? prevOk / (prevOk + prevFailed) : null,
    },
    daily,
    failuresByReason,
    failedNotRetried,
    topPublishers,
    lastPublished: lastRows.map((r) => ({ shareName: r.share_name, recipientName: r.recipient_name, by: r.by_user, at: r.at })),
  };
}

async function tier3(warehouseId, { days, connections }) {
  if (String(process.env.BDC_USAGE_FROM_AUDIT || 'true').toLowerCase() === 'false') {
    return { available: false, reason: 'disabled', enable: { text: 'Usage KPIs are turned off (BDC_USAGE_FROM_AUDIT=false).' } };
  }
  const ids = connections.map((c) => c.id).filter((i) => /^[A-Za-z0-9-]+$/.test(String(i || '')));
  if (!ids.length) return { available: true, byConnection: [], byTable: [], daily: [], totals: { queries: 0, rows: 0, bytes: 0 } };
  const spId = process.env.DATABRICKS_CLIENT_ID || '<app-sp-client-id>';
  let rows;
  try {
    rows = await spSqlQuery(warehouseId,
      `SELECT CAST(event_date AS STRING) AS d, ` +
      `get_json_object(response.result, '$.deltaSharingRecipientId') AS recipient_id, ` +
      `get_json_object(response.result, '$.tableName') AS table_name, ` +
      `COUNT(*) AS queries, ` +
      `SUM(CAST(get_json_object(response.result, '$.numRecords') AS BIGINT)) AS num_records, ` +
      `SUM(CAST(get_json_object(response.result, '$.scannedAddFileSize') AS BIGINT)) AS bytes, ` +
      `CAST(MAX(event_time) AS STRING) AS last_read ` +
      `FROM system.access.audit ` +
      `WHERE service_name = 'unityCatalog' ` +
      `AND action_name IN ('deltaSharingQueriedTable', 'deltaSharingQueriedTableChanges') ` +
      `AND event_date >= date_sub(current_date(), :days) ` +
      `AND get_json_object(response.result, '$.deltaSharingRecipientId') IN (${ids.map((i) => `'${i}'`).join(', ')}) ` +
      `GROUP BY 1, 2, 3`,
      [{ name: 'days', value: String(days), type: 'INT' }]);
  } catch (e) {
    return {
      available: false,
      reason: 'no_access',
      error: e.message,
      enable: {
        text: 'Optional: let the app read Delta Sharing events from the audit log to show SAP read activity. ' +
          'The app SP can then read the whole audit table; results shown here are limited to shares the viewer can see.',
        sql: [
          `GRANT USE CATALOG ON CATALOG system TO \`${spId}\``,
          `GRANT USE SCHEMA ON SCHEMA system.access TO \`${spId}\``,
          `GRANT SELECT ON TABLE system.access.audit TO \`${spId}\``,
        ],
      },
    };
  }
  const nameById = new Map(connections.map((c) => [c.id, c.name]));
  const byConn = new Map();
  const byTable = new Map();
  const daily = new Map();
  const totals = { queries: 0, rows: 0, bytes: 0 };
  for (const r of rows) {
    const conn = nameById.get(r.recipient_id) || r.recipient_id;
    const q = Number(r.queries) || 0;
    const n = Number(r.num_records) || 0;
    const b = Number(r.bytes) || 0;
    totals.queries += q; totals.rows += n; totals.bytes += b;
    const c = byConn.get(conn) || { connection: conn, queries: 0, rows: 0, bytes: 0, lastRead: null, tables: new Set() };
    c.queries += q; c.rows += n; c.bytes += b;
    if (!c.lastRead || r.last_read > c.lastRead) c.lastRead = r.last_read;
    if (r.table_name) c.tables.add(String(r.table_name).toLowerCase());
    byConn.set(conn, c);
    const tk = `${conn}\0${r.table_name}`;
    const t = byTable.get(tk) || { connection: conn, table: r.table_name, queries: 0, rows: 0, bytes: 0, lastRead: null };
    t.queries += q; t.rows += n; t.bytes += b;
    if (!t.lastRead || r.last_read > t.lastRead) t.lastRead = r.last_read;
    byTable.set(tk, t);
    daily.set(r.d, (daily.get(r.d) || 0) + q);
  }
  return {
    available: true,
    totals,
    byConnection: Array.from(byConn.values()).map((c) => ({ ...c, tables: Array.from(c.tables) })).sort((a, b) => b.queries - a.queries),
    byTable: Array.from(byTable.values()).sort((a, b) => b.queries - a.queries).slice(0, 20),
    daily: Array.from(daily.entries()).map(([date, queries]) => ({ date, queries })).sort((a, b) => a.date.localeCompare(b.date)),
  };
}

async function buildDashboard(req, { warehouseId, days, all }) {
  const user = requireRequestUser(req);
  const userEmail = user.email || user.userName;

  // Tier 1
  const overview = await loadOverview(req, warehouseId);
  const published = overview.shares.filter((s) => s.publishedToBdc);
  const [summaryRows, t2] = await Promise.all([
    getShareSourceSummary(req, warehouseId, published.map((s) => s.name)).catch((e) => {
      console.error('[dashboard] source summary failed', e.message); return [];
    }),
    tier2(req, { warehouseId, days, userEmail, all }).catch((e) => ({ available: false, reason: 'error', error: e.message })),
  ]);
  const summary = new Map(summaryRows.map((r) => [r.share_name, r]));
  const usedConnections = overview.connections.filter((c) => published.some((s) => s.bdcConnections.some((b) => b.name === c.name)));
  const t3 = await tier3(warehouseId, { days, connections: usedConnections })
    .catch((e) => ({ available: false, reason: 'error', error: e.message }));
  const pendingRevokes = await getPendingRevokes(all ? null : userEmail, warehouseId).catch(() => []);

  const lastPub = new Map((t2.available ? t2.lastPublished : []).map((p) => [`${p.shareName}\0${p.recipientName}`, p]));
  const usageByConn = new Map((t3.available ? t3.byConnection : []).map((c) => [c.connection, c]));

  const rows = [];
  for (const s of published) {
    const sm = summary.get(s.name);
    for (const c of s.bdcConnections) {
      const lp = lastPub.get(`${s.name}\0${c.name}`) || null;
      const usage = usageByConn.get(c.name) || null;
      rows.push({
        shareName: s.name,
        connection: c.name,
        owner: s.owner,
        isOwner: s.isOwner,
        tables: sm ? Number(sm.table_count) : s.tableCount,
        tablesWithoutPk: sm ? Number(sm.tables_without_pk) : null,
        sourceLastAltered: sm ? sm.source_last_altered : null,
        lastPublishedAt: lp ? lp.at : null,
        lastPublishedBy: lp ? lp.by : null,
        // Per-connection, not per-share: audit events carry the recipient
        // and the shared table name, not the share.
        lastReadByConnection: usage ? usage.lastRead : null,
      });
    }
  }

  // Needs attention
  const attention = [];
  for (const r of rows) {
    const alt = ts(r.sourceLastAltered);
    const pub = ts(r.lastPublishedAt);
    if (alt && pub && alt > pub) {
      attention.push({ kind: 'drift', shareName: r.shareName, connection: r.connection,
        text: 'A source table changed after the last publish. The schema in BDC may be out of date.', action: 'republish' });
    }
    if (t3.available && pub && Date.now() - pub > UNUSED_AFTER_DAYS * 86400_000 && !usageByConn.get(r.connection)) {
      attention.push({ kind: 'unused', shareName: r.shareName, connection: r.connection,
        text: `Published more than ${UNUSED_AFTER_DAYS} days ago, no SAP reads in the last ${days} days.`, action: 'review' });
    }
  }
  for (const p of pendingRevokes) {
    attention.push({ kind: 'revoke_pending', shareName: p.shareName, connection: p.recipientName,
      text: 'Removed from BDC, but the SELECT grant on the share is still in place.', action: 'finish_revoke' });
  }
  if (t2.available) {
    for (const f of t2.failedNotRetried) {
      attention.push({ kind: 'failed', shareName: f.shareName, connection: f.recipientName,
        text: 'The last publish failed and was not retried.', action: 'publish', runId: f.runId });
    }
  }

  const tablesInBdc = rows.length ? Array.from(new Map(rows.map((r) => [r.shareName, r])).values())
    .reduce((acc, r) => acc + (Number(r.tables) || 0), 0) : 0;
  const tablesWithoutPk = Array.from(new Map(rows.map((r) => [r.shareName, r])).values())
    .reduce((acc, r) => acc + (Number(r.tablesWithoutPk) || 0), 0);

  return {
    window: `${days}d`,
    days,
    viewingAll: all,
    generatedAt: new Date().toISOString(),
    tier1: {
      available: true,
      source: overview.source,
      sharesInBdc: published.length,
      connectionsInUse: usedConnections.length,
      tablesInBdc,
      tablesWithoutPk,
      ownedShares: overview.counts.owned,
      visibleShares: overview.counts.total,
    },
    tier2: t2,
    tier3: t3,
    published: rows,
    attention,
    pendingRevokes,
  };
}

router.get('/', async (req, res, next) => {
  try {
    const user = requireRequestUser(req);
    const warehouseId = String(req.query.warehouseId || '');
    if (!warehouseId) { const e = new Error('warehouseId is required'); e.status = 400; throw e; }
    noteWarehouse(warehouseId);
    const days = WINDOWS[String(req.query.window || '30d')] || 30;
    const isAdmin = await isActivityAdmin(req, user.email);
    const all = String(req.query.all || '') === 'true' && isAdmin;
    budgeted(req, res, next, `dashboard:${userKey(req)}:${warehouseId}:${days}:${all}`,
      async () => ({ ...(await buildDashboard(req, { warehouseId, days, all })), isAdmin }),
      { ttlMs: 5 * 60_000, refresh: !!req.query.refresh });
  } catch (err) { next(err); }
});

export default router;
