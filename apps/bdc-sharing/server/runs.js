// Run tracking and reconciliation.
//
// v1 wrote a job's outcome only while the browser kept polling it. Closing
// the tab lost the success/failure event, and for deletes it also skipped
// the REVOKE. Now:
//   - Every submit is recorded here (and as a *_submitted event in the
//     activity table) with the share and connection taken from the server's
//     own request, never from client query params.
//   - Whoever looks at a run first (a browser poll or the 60s reconciler)
//     writes the terminal event. The table-level NOT EXISTS makes that
//     idempotent across pollers and restarts.
//   - A successful delete becomes "revoke pending". The REVOKE needs the
//     user's privileges, so it runs on that user's next request (see
//     finalizePendingForUser) or from the Dashboard.

import { getJobRun, getJobRunOutput } from './dbx.js';
import {
  writeActivityEvent, listOpenRuns, findSubmittedRun, listPendingRevokes,
  getLastWarehouseId, onFirstWarehouse,
} from './activity.js';
import { getActivityTable } from './config.js';
import { mapLimit } from './lib/budget.js';

const RECONCILE_MS = 60_000;

const tracked = new Map();        // runId -> record, until its outcome is written
const records = new Map();        // runId -> record, kept after the outcome (bounded)
const MAX_RECORDS = 500;
const finished = new Set();       // runIds whose terminal event we handled
const pendingRevokes = new Map(); // `${share}\0${recipient}` -> record (used when no activity table)

export function isTerminal(run) {
  const life = run.state?.life_cycle_state || '';
  return life === 'TERMINATED' || life === 'INTERNAL_ERROR' || life === 'SKIPPED';
}
export function isSuccess(run) {
  return isTerminal(run) && run.state?.result_state === 'SUCCESS';
}

export function trackRun(rec) {
  const r = { ...rec, runId: String(rec.runId), submittedAt: Date.now() };
  tracked.set(r.runId, r);
  records.set(r.runId, r);
  if (records.size > MAX_RECORDS) records.delete(records.keys().next().value);
}

export async function getRunRecord(runId) {
  const id = String(runId);
  if (records.has(id)) return records.get(id);
  const wh = getLastWarehouseId();
  try {
    const row = await findSubmittedRun(wh, id);
    if (!row) return null;
    return fromRow(row);
  } catch { return null; }
}

function fromRow(row) {
  const action = row.event_type === 'republish_submitted' ? 'republish' : row.action;
  return {
    runId: String(row.run_id),
    action,
    shareName: row.share_name,
    recipientName: row.recipient_name,
    userEmail: row.user_email,
    warehouseId: row.warehouse_id,
  };
}

// Classify a job failure into a known bucket. The Dashboard groups failures
// by these codes and links each one to its FAQ entry.
export function classifyFailure(message) {
  const m = String(message || '').toLowerCase();
  if (m.includes('secret does not exist') || m.includes('secret scope')) return 'secret_scope_missing';
  if (m.includes('permission_denied') || m.includes('does not have') || m.includes('insufficient privileges')) {
    return m.includes('table') || m.includes('catalog') || m.includes('schema') ? 'missing_sp_grant' : 'privilege_denied';
  }
  if (m.includes('primary key')) return 'pk_missing';
  if (m.includes('not found') || m.includes('does_not_exist') || m.includes('does not exist')) return 'object_not_found';
  return 'other';
}

async function failureMessage(run) {
  const taskRunId = (run.tasks && run.tasks[0] && run.tasks[0].run_id) || run.run_id;
  try {
    const o = await getJobRunOutput(taskRunId);
    return o.error || run.state?.state_message || null;
  } catch {
    return run.state?.state_message || null;
  }
}

// Record the outcome of a run once. Safe to call from any poller.
export async function observeRun(rec, run, knownError) {
  if (!rec || !isTerminal(run)) return;
  const id = String(rec.runId);
  if (finished.has(id)) return;
  finished.add(id);
  tracked.delete(id);
  const ok = isSuccess(run);
  const action = rec.action || 'publish';
  const prefix = action === 'delete' ? 'delete' : action === 'republish' ? 'republish' : 'publish';
  const msg = ok ? null : (knownError || await failureMessage(run));
  await writeActivityEvent({
    eventType: `${prefix}_job_${ok ? 'succeeded' : 'failed'}`,
    action: action === 'republish' ? 'publish' : action,
    userEmail: rec.userEmail,
    shareName: rec.shareName,
    recipientName: rec.recipientName,
    runId: id,
    warehouseId: rec.warehouseId,
    errorCode: ok ? null : classifyFailure(msg),
    errorMessage: msg,
    onceKey: true,
  });
  if (ok && action === 'delete') {
    pendingRevokes.set(`${rec.shareName}\0${rec.recipientName}`, { ...rec, at: Date.now() });
    await writeActivityEvent({
      eventType: 'delete_revoke_pending',
      action: 'delete',
      userEmail: rec.userEmail,
      shareName: rec.shareName,
      recipientName: rec.recipientName,
      runId: id,
      warehouseId: rec.warehouseId,
      onceKey: true,
    });
  }
}

export function clearPendingRevoke(shareName, recipientName) {
  pendingRevokes.delete(`${shareName}\0${recipientName}`);
}

// Pending REVOKEs for one user (or all users when email is null).
export async function getPendingRevokes(userEmail, warehouseId) {
  const wh = warehouseId || getLastWarehouseId();
  const fromMemory = Array.from(pendingRevokes.values())
    .filter((r) => !userEmail || String(r.userEmail).toLowerCase() === String(userEmail).toLowerCase())
    .map((r) => ({ shareName: r.shareName, recipientName: r.recipientName, runId: r.runId, userEmail: r.userEmail }));
  if (!(await getActivityTable()) || !wh) return fromMemory;
  try {
    const rows = await listPendingRevokes(wh, userEmail);
    // Memory covers deletes whose events are still being written.
    const seen = new Set(fromMemory.map((r) => `${r.shareName}\0${r.recipientName}`));
    const out = [...fromMemory];
    for (const r of rows) {
      const k = `${r.share_name}\0${r.recipient_name}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ shareName: r.share_name, recipientName: r.recipient_name, runId: r.run_id, userEmail: r.user_email, at: r.event_time });
    }
    return out;
  } catch (e) {
    console.error('[runs] pending revoke lookup failed', e.message);
    return fromMemory;
  }
}

let reconciling = false;
export async function reconcileOnce() {
  if (reconciling) return { skipped: true };
  reconciling = true;
  try {
    const candidates = new Map(Array.from(tracked.values()).map((r) => [r.runId, r]));
    const wh = getLastWarehouseId();
    if (wh && await getActivityTable()) {
      try {
        for (const row of await listOpenRuns(wh)) {
          const rec = fromRow(row);
          if (!candidates.has(rec.runId) && !finished.has(rec.runId)) candidates.set(rec.runId, rec);
        }
      } catch (e) { console.error('[runs] open-run lookup failed', e.message); }
    }
    let closed = 0;
    await mapLimit(Array.from(candidates.values()), 4, async (rec) => {
      try {
        const run = await getJobRun(rec.runId);
        if (isTerminal(run)) { await observeRun(rec, run); closed += 1; }
      } catch (e) {
        // Run purged or not visible to the SP: stop retrying it from memory.
        if (e.status === 400 || e.status === 404) tracked.delete(rec.runId);
      }
    });
    return { checked: candidates.size, closed };
  } finally {
    reconciling = false;
  }
}

export function startReconciler() {
  const tick = () => reconcileOnce().catch((e) => console.error('[runs] reconcile failed', e.message));
  // Run as soon as the first request tells us which warehouse to use, then
  // on a fixed interval.
  onFirstWarehouse(() => setTimeout(tick, 1000));
  const t = setInterval(tick, RECONCILE_MS);
  if (t.unref) t.unref();
}
