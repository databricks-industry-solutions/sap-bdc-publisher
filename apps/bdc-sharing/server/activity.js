// Application-level activity log. Records every publish / delete attempt and
// outcome to a Delta table so the app surfaces a per-user "who shared what"
// trail — separate from system.access.audit (which only sees the SQL grants)
// and from the Jobs run history (which attributes everything to the SP).

import crypto from 'node:crypto';
import { spExecuteStatement, executeStatement } from './dbx.js';
import { getActivityTable } from './config.js';

// Dedup terminal job-state events across the multiple GET /:runId polls that
// the UI fires after a job lands. In-process Set keyed `${runId}:${eventType}`;
// reset on app restart, which is acceptable per the design doc.
const terminalEventsLogged = new Set();

export function shouldLogTerminalOnce(runId, eventType) {
  const key = `${runId}:${eventType}`;
  if (terminalEventsLogged.has(key)) return false;
  terminalEventsLogged.add(key);
  return true;
}

function buildEventParams(event) {
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
    { name: 'error_message',  value: event.errorMessage || null,                       type: 'STRING' },
    { name: 'metadata_json',  value: event.metadata ? JSON.stringify(event.metadata) : null, type: 'STRING' },
    { name: 'app_deployment', value: process.env.DATABRICKS_APP_NAME || null,          type: 'STRING' },
  ];
}

// Best-effort writer. Never throws — auditing must never block the user flow.
export async function writeActivityEvent(event) {
  const table = await getActivityTable();
  if (!table) return;
  if (!event.warehouseId) {
    console.error('[activity] skipped: warehouseId missing', { eventType: event.eventType });
    return;
  }
  const params = buildEventParams(event);
  // Explicit column list — the table has a generated `event_date` column for
  // partitioning that we never write to directly; positional VALUES would
  // misalign without naming.
  const stmt =
    `INSERT INTO ${table} (` +
    `event_id, event_time, event_type, user_email, action, ` +
    `share_name, recipient_name, run_id, warehouse_id, ` +
    `error_code, error_message, metadata_json, app_deployment) VALUES (` +
    `:event_id, current_timestamp(), :event_type, :user_email, :action, ` +
    `:share_name, :recipient_name, :run_id, :warehouse_id, ` +
    `:error_code, :error_message, :metadata_json, :app_deployment)`;
  try {
    await spExecuteStatement({ statement: stmt, warehouseId: event.warehouseId, parameters: params });
  } catch (e) {
    console.error('[activity] write failed', {
      eventType: event.eventType,
      runId: event.runId || null,
      message: e.message,
    });
  }
}

// For each (share, recipient), returns 'published' iff the latest terminal
// event is publish_job_succeeded; 'unpublished' iff it is delete_finalized;
// absent if no terminal event has ever fired for the pair. Used by the share
// dropdown to mark BDC-published recipients accurately — the SELECT grant
// alone is not a reliable signal (see routes/shares.js notes).
export async function getPublishStateMap(req, { warehouseId }) {
  const table = await getActivityTable();
  if (!table) return null;
  const stmt =
    `SELECT share_name, recipient_name, event_type FROM ` +
    `(SELECT share_name, recipient_name, event_type, ` +
    `ROW_NUMBER() OVER (PARTITION BY share_name, recipient_name ORDER BY event_time DESC) AS rn ` +
    `FROM ${table} ` +
    `WHERE event_type IN ('publish_job_succeeded', 'delete_finalized')) ` +
    `WHERE rn = 1`;
  const result = await executeStatement(req, { statement: stmt, warehouseId });
  const rows = result.result?.data_array || [];
  const map = new Map();
  for (const r of rows) {
    const [shareName, recipientName, eventType] = r;
    if (!shareName || !recipientName) continue;
    map.set(shareName + '\x00' + recipientName, eventType);
  }
  return map;
}

// Read path goes via the user's OBO token so UC enforces row visibility — the
// audit table is granted SELECT to all logged-in users at provisioning time.
// `all` is honored at the route level only after admin-group membership check.
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
