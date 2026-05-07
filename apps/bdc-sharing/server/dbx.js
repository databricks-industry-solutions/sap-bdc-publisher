// Databricks REST wrappers. Two auth modes co-exist:
//   - SP token  (client_credentials, from spAuth.js) — used for warehouse
//     start/state polling and Jobs submit/get. These run as the SP itself
//     (no run_as), so the SP no longer needs workspace admin.
//   - User OBO token (x-forwarded-access-token) — used for EVERYTHING that
//     needs the user's UC privileges: listing warehouses, SHOW SHARES /
//     SHOW RECIPIENTS, DESCRIBE, SHOW GRANTS, information_schema lookups,
//     and the GRANT/REVOKE on the share. Reads (and now the privilege
//     mutations) reflect the logged-in user's identity.

import { requireHost, getUserToken } from './auth.js';
import { getSpToken } from './spAuth.js';

async function fetchWithToken(token, urlPath, init = {}) {
  const host = requireHost();
  const url = `${host}${urlPath}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    ...(init.headers || {}),
  };
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) {
    const err = new Error(
      body?.message || body?.error_code || `Databricks API error ${res.status}`
    );
    err.status = res.status;
    err.code = body?.error_code || 'databricks_api_error';
    err.details = { url, status: res.status, body };
    throw err;
  }
  return body;
}

// SP-token-based helpers
async function spGet(urlPath) { return fetchWithToken(await getSpToken(), urlPath, { method: 'GET' }); }
async function spPost(urlPath, body) { return fetchWithToken(await getSpToken(), urlPath, { method: 'POST', body: JSON.stringify(body || {}) }); }

// User-OBO-token-based helpers
function userGet(req, urlPath) { return fetchWithToken(getUserToken(req), urlPath, { method: 'GET' }); }
function userPost(req, urlPath, body) { return fetchWithToken(getUserToken(req), urlPath, { method: 'POST', body: JSON.stringify(body || {}) }); }

// -----------------------------------------------------------------------------
// SQL Warehouses — all warehouse ops use the SP so the list the user sees
// matches what the SP can actually start on their behalf.
// -----------------------------------------------------------------------------

export async function listWarehouses() {
  const body = await spGet('/api/2.0/sql/warehouses');
  return body.warehouses || [];
}

export function getWarehouse(id) {
  return spGet(`/api/2.0/sql/warehouses/${encodeURIComponent(id)}`);
}

export function startWarehouseSp(id) {
  return spPost(`/api/2.0/sql/warehouses/${encodeURIComponent(id)}/start`, {});
}

// SP-side poll of warehouse state (used while waiting after a start).
export function getWarehouseSp(id) {
  return spGet(`/api/2.0/sql/warehouses/${encodeURIComponent(id)}`);
}

const CLASSIC_SIZE_ORDER = [
  '2X-Small', 'X-Small', 'Small', 'Medium', 'Large',
  'X-Large', '2X-Large', '3X-Large', '4X-Large',
];
function classicSizeRank(size) {
  const i = CLASSIC_SIZE_ORDER.indexOf(size);
  return i === -1 ? 999 : i;
}

export function rankWarehouses(whs) {
  const alive = whs.filter((w) => w.state !== 'DELETED' && w.state !== 'DELETING');
  const serverless = alive.filter((w) => w.enable_serverless_compute);
  const classic = alive.filter((w) => !w.enable_serverless_compute);
  serverless.sort((a, b) => (a.state === 'RUNNING' ? -1 : b.state === 'RUNNING' ? 1 : 0));
  classic.sort((a, b) => classicSizeRank(a.cluster_size) - classicSizeRank(b.cluster_size));
  return [...serverless, ...classic];
}

// Kick off a warehouse start if stopped, then return immediately. The client
// polls GET /api/warehouses/:id for real-time state updates.
export async function kickWarehouseStart(id) {
  const cur = await getWarehouseSp(id);
  let started = false;
  if (cur.state === 'STOPPED') {
    await startWarehouseSp(id);
    started = true;
  }
  const after = await getWarehouseSp(id);
  return { warehouse: after, started };
}

// -----------------------------------------------------------------------------
// Statement Execution — user OBO (queries run as the user).
// -----------------------------------------------------------------------------

export async function executeStatement(req, { statement, warehouseId, parameters }) {
  const submitBody = {
    warehouse_id: warehouseId,
    statement,
    wait_timeout: '30s',
    on_wait_timeout: 'CONTINUE',
  };
  if (parameters && parameters.length) submitBody.parameters = parameters;
  const submit = await userPost(req, '/api/2.0/sql/statements', submitBody);
  let state = submit.status?.state;
  let statementId = submit.statement_id;
  let last = submit;
  const started = Date.now();
  while (['PENDING', 'RUNNING'].includes(state)) {
    if (Date.now() - started > 120_000) {
      const err = new Error(`Statement ${statementId} timed out after 120s (state=${state})`);
      err.status = 504; err.code = 'statement_timeout';
      throw err;
    }
    await new Promise((r) => setTimeout(r, 1500));
    last = await userGet(req, `/api/2.0/sql/statements/${statementId}`);
    state = last.status?.state;
  }
  if (state !== 'SUCCEEDED') {
    const err = new Error(last.status?.error?.message || `SQL statement ended in state ${state}`);
    err.status = 400; err.code = last.status?.error?.error_code || 'statement_failed';
    err.details = { statement, state, result: last };
    throw err;
  }
  return last;
}

// SP-token variant of executeStatement. Used by the activity-log writer so the
// app SP owns every INSERT into the audit table regardless of which user
// triggered the event.
export async function spExecuteStatement({ statement, warehouseId, parameters }) {
  const submitBody = {
    warehouse_id: warehouseId,
    statement,
    wait_timeout: '30s',
    on_wait_timeout: 'CONTINUE',
  };
  if (parameters && parameters.length) submitBody.parameters = parameters;
  const submit = await spPost('/api/2.0/sql/statements', submitBody);
  let state = submit.status?.state;
  let statementId = submit.statement_id;
  let last = submit;
  const started = Date.now();
  while (['PENDING', 'RUNNING'].includes(state)) {
    if (Date.now() - started > 120_000) {
      const err = new Error(`Statement ${statementId} timed out after 120s (state=${state})`);
      err.status = 504; err.code = 'statement_timeout';
      throw err;
    }
    await new Promise((r) => setTimeout(r, 1500));
    last = await spGet(`/api/2.0/sql/statements/${statementId}`);
    state = last.status?.state;
  }
  if (state !== 'SUCCEEDED') {
    const err = new Error(last.status?.error?.message || `SQL statement ended in state ${state}`);
    err.status = 400; err.code = last.status?.error?.error_code || 'statement_failed';
    err.details = { statement, state, result: last };
    throw err;
  }
  return last;
}

export async function sqlQuery(req, warehouseId, statement) {
  const result = await executeStatement(req, { statement, warehouseId });
  const cols = (result.manifest?.schema?.columns || []).map((c) => c.name);
  const rows = result.result?.data_array || [];
  return rows.map((r) => {
    const o = {};
    cols.forEach((c, i) => { o[c] = r[i]; });
    return o;
  });
}

function idQ(name) { return '`' + String(name).replace(/`/g, '``') + '`'; }

// -----------------------------------------------------------------------------
// SCIM — user OBO
// -----------------------------------------------------------------------------

export async function getUserGroupsByEmail(req, email) {
  // Kept for back-compat — `email` is unused, the SCIM Me endpoint always
  // returns the calling user's record. The `iam.current-user:read` OBO scope
  // covers /Me but not /Users by filter, so we read the current user only.
  void email;
  const body = await userGet(req, `/api/2.0/preview/scim/v2/Me?attributes=groups,userName`).catch(() => null);
  if (!body) return [];
  return (body.groups || []).map((g) => g.display).filter(Boolean);
}

// -----------------------------------------------------------------------------
// Delta Sharing (SQL-based) — user OBO
// -----------------------------------------------------------------------------

export async function listSharesRaw(req, warehouseId) {
  const rows = await sqlQuery(req, warehouseId, 'SHOW SHARES');
  return rows.map((r) => ({ name: r.share, created_at: r.created_at, created_by: r.created_by, comment: r.comment }));
}

export async function listRecipientsRaw(req, warehouseId) {
  const rows = await sqlQuery(req, warehouseId, 'SHOW RECIPIENTS');
  return rows.map((r) => ({
    name: r.recipient,
    authentication_type: r.authentication_type,
    created_at: r.created_at,
    created_by: r.created_by,
    comment: r.comment,
  }));
}

export function showGrantsOnShare(req, warehouseId, name) {
  return sqlQuery(req, warehouseId, `SHOW GRANTS ON SHARE ${idQ(name)}`);
}
export function showGrantsOnRecipient(req, warehouseId, name) {
  return sqlQuery(req, warehouseId, `SHOW GRANTS ON RECIPIENT ${idQ(name)}`);
}
export function describeShare(req, warehouseId, name) {
  return sqlQuery(req, warehouseId, `DESCRIBE SHARE ${idQ(name)}`).catch(() => []);
}
export function describeRecipient(req, warehouseId, name) {
  return sqlQuery(req, warehouseId, `DESCRIBE RECIPIENT ${idQ(name)}`).catch(() => []);
}
export function showAllInShare(req, warehouseId, name) {
  return sqlQuery(req, warehouseId, `SHOW ALL IN SHARE ${idQ(name)}`).catch(() => []);
}

// GRANT / REVOKE run as the calling user via OBO. UC's per-securable check
// (ALTER / ownership on the share) decides whether the statement succeeds —
// the workspace admin role on the SP is irrelevant here.
export function grantSelectOnShare(req, warehouseId, shareName, recipientName) {
  return executeStatement(req, {
    warehouseId,
    statement: `GRANT SELECT ON SHARE ${idQ(shareName)} TO RECIPIENT ${idQ(recipientName)}`,
  });
}
export function revokeSelectOnShare(req, warehouseId, shareName, recipientName) {
  return executeStatement(req, {
    warehouseId,
    statement: `REVOKE SELECT ON SHARE ${idQ(shareName)} FROM RECIPIENT ${idQ(recipientName)}`,
  });
}

// -----------------------------------------------------------------------------
// Table inspection — user OBO
// -----------------------------------------------------------------------------

function parseFullName(fullName) {
  const parts = String(fullName || '').split('.');
  if (parts.length !== 3) return null;
  return { catalog: parts[0], schema: parts[1], table: parts[2] };
}

export async function describeTableColumns(req, warehouseId, fullName) {
  const rows = await sqlQuery(req, warehouseId, `DESCRIBE TABLE ${fullName}`).catch(() => []);
  const cols = [];
  for (const r of rows) {
    const name = r.col_name || r['# col_name'];
    if (!name) continue;
    if (name.startsWith('#') || name === '') break;
    cols.push({ name, type: r.data_type || null });
  }
  return cols;
}

export async function getTablePrimaryKey(req, warehouseId, fullName) {
  const p = parseFullName(fullName);
  if (!p) return [];
  const esc = (s) => String(s).replace(/'/g, "''");
  const q =
    `SELECT kcu.column_name, kcu.ordinal_position ` +
    `FROM system.information_schema.table_constraints tc ` +
    `JOIN system.information_schema.key_column_usage kcu ` +
    `ON tc.constraint_catalog = kcu.constraint_catalog ` +
    `AND tc.constraint_schema = kcu.constraint_schema ` +
    `AND tc.constraint_name = kcu.constraint_name ` +
    `WHERE tc.constraint_type = 'PRIMARY KEY' ` +
    `AND tc.table_catalog = '${esc(p.catalog)}' ` +
    `AND tc.table_schema = '${esc(p.schema)}' ` +
    `AND tc.table_name = '${esc(p.table)}' ` +
    `ORDER BY kcu.ordinal_position`;
  const rows = await sqlQuery(req, warehouseId, q).catch(() => []);
  return rows.map((r) => r.column_name).filter(Boolean);
}

// -----------------------------------------------------------------------------
// Jobs — SP (submit + poll). The Job runs as the SP itself: it only invokes
// the BDC SDK, which doesn't depend on user identity. The user-privileged
// SQL (GRANT / REVOKE) is executed separately via OBO before/after the Job,
// so we no longer need run_as — and therefore the SP no longer needs to be
// a workspace admin.
// -----------------------------------------------------------------------------

export async function submitBdcPublishJob({ notebookPath, parameters }) {
  const body = {
    run_name: `bdc-publish-${parameters.share_name}-${Date.now()}`,
    tasks: [
      {
        task_key: 'bdc_publish',
        notebook_task: { notebook_path: notebookPath, base_parameters: parameters, source: 'WORKSPACE' },
        environment_key: 'bdc_env',
      },
    ],
    environments: [
      { environment_key: 'bdc_env', spec: { client: '2', dependencies: ['sap-bdc-connect-sdk'] } },
    ],
  };
  return spPost('/api/2.2/jobs/runs/submit', body);
}

export async function submitBdcUnpublishJob({ notebookPath, parameters }) {
  const body = {
    run_name: `bdc-unpublish-${parameters.share_name}-${Date.now()}`,
    tasks: [
      {
        task_key: 'bdc_unpublish',
        notebook_task: { notebook_path: notebookPath, base_parameters: parameters, source: 'WORKSPACE' },
        environment_key: 'bdc_env',
      },
    ],
    environments: [
      { environment_key: 'bdc_env', spec: { client: '2', dependencies: ['sap-bdc-connect-sdk'] } },
    ],
  };
  return spPost('/api/2.2/jobs/runs/submit', body);
}

export function getJobRun(runId) {
  return spGet(`/api/2.2/jobs/runs/get?run_id=${encodeURIComponent(runId)}`);
}

// Notebook-task error + stdout + dbutils.notebook.exit() value. Takes a TASK
// run_id (not the parent run). For our single-task publish job they're the
// same unless the multi-task runner nests; we resolve a task run_id from the
// parent run before calling this.
export function getJobRunOutput(runId) {
  return spGet(`/api/2.2/jobs/runs/get-output?run_id=${encodeURIComponent(runId)}`);
}

// -----------------------------------------------------------------------------
// App self-introspection — SP
// -----------------------------------------------------------------------------

export async function getAppDeploymentPath(appName) {
  const body = await spGet(`/api/2.0/apps/${encodeURIComponent(appName)}`);
  const path = body?.active_deployment?.deployment_artifacts?.source_code_path;
  if (!path) {
    const err = new Error(`App ${appName} has no active deployment source_code_path`);
    err.status = 500; err.code = 'no_deployment_path';
    throw err;
  }
  return path;
}
