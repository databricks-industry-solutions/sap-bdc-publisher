// Application-level activity log. Records every publish / delete attempt and
// outcome to a Delta table so the app surfaces a per-user "who shared what"
// trail, separate from system.access.audit (which only sees the SQL grants)
// and from the Jobs run history (which attributes everything to the SP).
//
// Writes always run as the app SP. Reads for the Activity page run as the
// user (OBO); the per-user filter there is applied by the app, not by Unity
// Catalog. Anyone with SELECT on the table can read every row in DBSQL.

import crypto from 'node:crypto';
import { spExecuteStatement, executeStatement, spSqlQuery } from './dbx.js';
import { getActivityTable } from './config.js';

export const TERMINAL_EVENT_TYPES = [
  'publish_job_succeeded', 'publish_job_failed',
  'republish_job_succeeded', 'republish_job_failed',
  'delete_job_succeeded', 'delete_job_failed',
];
export const SUBMITTED_EVENT_TYPES = ['publish_submitted', 'republish_submitted', 'delete_submitted'];

// Columns added in v2. Older tables lack them until the owner runs the
// migration from the Activity page, so the writer only sends the ones that
// exist.
export const V2_COLUMNS = [
  { name: 'bdc_connection', type: 'STRING' },
  { name: 'share_object_count', type: 'INT' },
  { name: 'source_last_altered', type: 'TIMESTAMP' },
];

// Remembered so background work (the run reconciler) has a warehouse to use.
let lastWarehouseId = null;
const warehouseListeners = [];
export function noteWarehouse(id) {
  if (!id || id === lastWarehouseId) return;
  const first = !lastWarehouseId;
  lastWarehouseId = id;
  if (first) warehouseListeners.forEach((fn) => { try { fn(id); } catch { /* ignore */ } });
}
export function getLastWarehouseId() { return lastWarehouseId; }
export function onFirstWarehouse(fn) { warehouseListeners.push(fn); }

const columnCache = new Map(); // table -> { cols: Set, at }
export async function getActivityColumns(table, warehouseId) {
  const hit = columnCache.get(table);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.cols;
  const result = await spExecuteStatement({ statement: `SELECT * FROM ${table} LIMIT 0`, warehouseId });
  const cols = new Set((result.manifest?.schema?.columns || []).map((c) => c.name.toLowerCase()));
  columnCache.set(table, { cols, at: Date.now() });
  return cols;
}
export function forgetActivityColumns() { columnCache.clear(); }

function baseParams(event) {
  return [
    { name: 'event_id',       value: crypto.randomUUID(),                              type: 'STRING' },
    { name: 'event_type',     value: String(event.eventType || ''),                    type: 'STRING' },
    { name: 'user_email',     value: String(event.userEmail || ''),                    type: 'STRING' },
    { name: 'action',         value: String(event.action || ''),                       type: 'STRING' },
    { name: 'share_name',     value: String(event.shareName || ''),                    type: 'STRING' },
    { name: 'recipient_name', value: String(event.recipientName || ''),                type: 'STRING' },
    { name: 'run_id',         value: event.runId == null ? null : String(event.runId), type: 'STRING' },
    { name: 'warehouse_id',   value: event.warehouseId || null,                        type: 'STRING' },
    { name: 'error_code',     value: event.errorCode || null,                          type: 'STRING' },
    { name: 'error_message',  value: event.errorMessage ? String(event.errorMessage).slice(0, 4000) : null, type: 'STRING' },
    { name: 'metadata_json',  value: event.metadata ? JSON.stringify(event.metadata) : null, type: 'STRING' },
    { name: 'app_deployment', value: process.env.DATABRICKS_APP_NAME || null,          type: 'STRING' },
  ];
}

const BASE_COLS = [
  'event_id', 'event_type', 'user_email', 'action', 'share_name', 'recipient_name',
  'run_id', 'warehouse_id', 'error_code', 'error_message', 'metadata_json', 'app_deployment',
];

async function buildInsert(table, event) {
  const params = baseParams(event);
  const cols = ['event_id', 'event_time', ...BASE_COLS.slice(1)];
  const vals = [':event_id', 'current_timestamp()', ...BASE_COLS.slice(1).map((c) => `:${c}`)];
  let have = new Set();
  try { have = await getActivityColumns(table, event.warehouseId); } catch { /* old table, skip v2 cols */ }
  const v2 = {
    bdc_connection: event.recipientName ? String(event.recipientName).toLowerCase() : null,
    share_object_count: event.shareObjectCount == null ? null : String(Number(event.shareObjectCount)),
    source_last_altered: event.sourceLastAltered || null,
  };
  for (const c of V2_COLUMNS) {
    if (!have.has(c.name)) continue;
    cols.push(c.name);
    vals.push(`CAST(:${c.name} AS ${c.type})`);
    params.push({ name: c.name, value: v2[c.name], type: 'STRING' });
  }
  return { cols, vals, params };
}

// Best-effort writer. Never throws: auditing must never block the user flow.
// Explicit column list because the generated `event_date` column must not be
// written.
export async function writeActivityEvent(event) {
  const table = await getActivityTable();
  const warehouseId = event.warehouseId || lastWarehouseId;
  if (!table) return false;
  if (!warehouseId) {
    console.error('[activity] skipped: no warehouse known', { eventType: event.eventType });
    return false;
  }
  noteWarehouse(warehouseId);
  const ev = { ...event, warehouseId };
  try {
    const { cols, vals, params } = await buildInsert(table, ev);
    let stmt;
    if (event.onceKey) {
      // Dedup on (run_id, event_type) in the table itself, so app restarts
      // and several pollers can't double-write a terminal event.
      params.push({ name: 'once_run_id', value: String(event.runId), type: 'STRING' });
      stmt = `INSERT INTO ${table} (${cols.join(', ')}) SELECT ${vals.join(', ')} ` +
        `WHERE NOT EXISTS (SELECT 1 FROM ${table} WHERE run_id = :once_run_id AND event_type = :event_type)`;
    } else {
      stmt = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${vals.join(', ')})`;
    }
    await spExecuteStatement({ statement: stmt, warehouseId, parameters: params });
    return true;
  } catch (e) {
    console.error('[activity] write failed', { eventType: event.eventType, runId: event.runId || null, message: e.message });
    return false;
  }
}

// Submitted runs from the last 7 days without a terminal event. These are
// the runs whose outcome nobody recorded yet (tab closed, app restarted).
export async function listOpenRuns(warehouseId) {
  const table = await getActivityTable();
  if (!table || !warehouseId) return [];
  const sub = SUBMITTED_EVENT_TYPES.map((t) => `'${t}'`).join(', ');
  const term = TERMINAL_EVENT_TYPES.map((t) => `'${t}'`).join(', ');
  return spSqlQuery(warehouseId,
    `SELECT s.run_id, s.event_type, s.action, s.user_email, s.share_name, s.recipient_name, s.warehouse_id, s.metadata_json ` +
    `FROM ${table} s WHERE s.event_type IN (${sub}) AND s.run_id IS NOT NULL ` +
    `AND s.event_time > current_timestamp() - INTERVAL 7 DAYS ` +
    `AND NOT EXISTS (SELECT 1 FROM ${table} x WHERE x.run_id = s.run_id AND x.event_type IN (${term}))`);
}

export async function findSubmittedRun(warehouseId, runId) {
  const table = await getActivityTable();
  if (!table || !warehouseId) return null;
  const sub = SUBMITTED_EVENT_TYPES.map((t) => `'${t}'`).join(', ');
  const rows = await spSqlQuery(warehouseId,
    `SELECT run_id, event_type, action, user_email, share_name, recipient_name, warehouse_id, metadata_json ` +
    `FROM ${table} WHERE run_id = :run_id AND event_type IN (${sub}) LIMIT 1`,
    [{ name: 'run_id', value: String(runId), type: 'STRING' }]);
  return rows[0] || null;
}

// Deletes that finished on the BDC side but whose REVOKE has not run yet.
// A later publish of the same pair also clears the pending state.
export async function listPendingRevokes(warehouseId, userEmail) {
  const table = await getActivityTable();
  if (!table || !warehouseId) return [];
  const params = [];
  let userFilter = '';
  if (userEmail) {
    userFilter = 'AND lower(j.user_email) = lower(:user_email) ';
    params.push({ name: 'user_email', value: String(userEmail), type: 'STRING' });
  }
  return spSqlQuery(warehouseId,
    `SELECT j.share_name, j.recipient_name, j.run_id, j.user_email, j.event_time ` +
    `FROM ${table} j WHERE j.event_type = 'delete_job_succeeded' ${userFilter}` +
    `AND j.event_time > current_timestamp() - INTERVAL 90 DAYS ` +
    `AND NOT EXISTS (SELECT 1 FROM ${table} f WHERE f.share_name = j.share_name AND f.recipient_name = j.recipient_name ` +
    `AND f.event_time >= j.event_time AND f.event_type IN ('delete_finalized', 'publish_submitted')) ` +
    `ORDER BY j.event_time DESC`, params);
}

export async function listActivityEvents(req, { warehouseId, userEmail, all = false, limit = 100 }) {
  const table = await getActivityTable();
  if (!table) return [];
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 1000);
  const params = [];
  let where = '';
  if (!all) {
    where = 'WHERE user_email = :user_email';
    params.push({ name: 'user_email', value: String(userEmail || ''), type: 'STRING' });
  }
  const stmt =
    `SELECT event_id, event_time, event_type, user_email, action, ` +
    `share_name, recipient_name, run_id, warehouse_id, ` +
    `error_code, error_message, metadata_json, app_deployment ` +
    `FROM ${table} ${where} ORDER BY event_time DESC LIMIT ${lim}`;
  const result = await executeStatement(req, { statement: stmt, warehouseId, parameters: params });
  const cols = (result.manifest?.schema?.columns || []).map((c) => c.name);
  const rows = result.result?.data_array || [];
  return rows.map((r) => {
    const o = {};
    cols.forEach((c, i) => { o[c] = r[i]; });
    return o;
  });
}
