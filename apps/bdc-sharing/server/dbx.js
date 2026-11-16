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
// SQL Warehouses. List runs under user OBO so the picker reflects what the
// caller can see; start and poll stay on the SP because the SP is what
// actually starts the warehouse on the user's behalf.
// -----------------------------------------------------------------------------

export async function listWarehouses(req) {
  const body = await userGet(req, '/api/2.0/sql/warehouses');
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
// Statement Execution. One implementation, two identities: the user (OBO)
// for anything that needs their UC privileges, the SP for activity-log
// writes, pre-flight probes and the reconciler.
// -----------------------------------------------------------------------------

const STATEMENT_TIMEOUT_MS = 120_000;

async function runStatement(get, post, { statement, warehouseId, parameters }) {
  const submitBody = {
    warehouse_id: warehouseId,
    statement,
    wait_timeout: '30s',
    on_wait_timeout: 'CONTINUE',
  };
  if (parameters && parameters.length) submitBody.parameters = parameters;
  let last = await post('/api/2.0/sql/statements', submitBody);
  const statementId = last.statement_id;
  let state = last.status?.state;
  const started = Date.now();
  while (['PENDING', 'RUNNING'].includes(state)) {
    if (Date.now() - started > STATEMENT_TIMEOUT_MS) {
      const err = new Error(`Statement ${statementId} timed out after 120s (state=${state})`);
      err.status = 504; err.code = 'statement_timeout';
      throw err;
    }
    await new Promise((r) => setTimeout(r, 1500));
    last = await get(`/api/2.0/sql/statements/${statementId}`);
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

export function executeStatement(req, args) {
  return runStatement((u) => userGet(req, u), (u, b) => userPost(req, u, b), args);
}

// The app SP owns every INSERT into the activity table regardless of which
// user triggered the event.
export function spExecuteStatement(args) {
  return runStatement(spGet, spPost, args);
}

function toObjects(result) {
  const cols = (result.manifest?.schema?.columns || []).map((c) => c.name);
  const rows = result.result?.data_array || [];
  return rows.map((r) => {
    const o = {};
    cols.forEach((c, i) => { o[c] = r[i]; });
    return o;
  });
}

export async function spSqlQuery(warehouseId, statement, parameters) {
  return toObjects(await spExecuteStatement({ statement, warehouseId, parameters }));
}

export async function sqlQuery(req, warehouseId, statement, parameters) {
  return toObjects(await executeStatement(req, { statement, warehouseId, parameters }));
}

export function idQ(name) { return '`' + String(name).replace(/`/g, '``') + '`'; }
export function sqlStr(s) { return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"; }

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

// GRANT / REVOKE run as the calling user via OBO. Unity Catalog requires
// either share ownership + USE RECIPIENT, or USE RECIPIENT + USE SHARE +
// SET SHARE PERMISSION. The SP's workspace role is irrelevant here.
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
  // Prefer the deploy-time `source_code_path` (e.g. `${workspace.file_path}/apps/<name>`)
  // over `deployment_artifacts.source_code_path` (the immutable Files-API snapshot
  // under `/Workspace/Users/<sp>/src/<hash>/`). The artifact snapshot only contains
  // the app subtree and stores `.py` files as plain workspace files — not registered
  // notebook objects — so resolving the publish/unpublish notebooks off it fails.
  const path =
    body?.active_deployment?.source_code_path ||
    body?.active_deployment?.deployment_artifacts?.source_code_path;
  if (!path) {
    const err = new Error(`App ${appName} has no active deployment source_code_path`);
    err.status = 500; err.code = 'no_deployment_path';
    throw err;
  }
  return path;
}

// -----------------------------------------------------------------------------
// Workspace import. Used at runtime to materialize the publish/unpublish
// notebooks under the SP's home so notebook_task can reference them. The Apps
// artifact snapshot stores .py files as plain workspace files, not registered
// notebook objects, so we re-import via the workspace API which converts
// SOURCE+language into a real notebook object.
// -----------------------------------------------------------------------------

export function workspaceMkdirsSp(p) {
  return spPost('/api/2.0/workspace/mkdirs', { path: p });
}

export function workspaceImportNotebookSp({ path: p, contentBase64, language = 'PYTHON' }) {
  return spPost('/api/2.0/workspace/import', {
    path: p,
    format: 'SOURCE',
    language,
    overwrite: true,
    content: contentBase64,
  });
}

// -----------------------------------------------------------------------------
// information_schema reads (v2). Each replaces a per-share or per-table loop
// of SHOW / DESCRIBE statements with one statement. All run as the user, so
// rows are limited to shares, recipients and tables the user can interact
// with (information_schema applies UC visibility).
// -----------------------------------------------------------------------------

const IS = 'system.information_schema';

// One row per (share, recipient grant). Shares without grants appear once
// with null recipient columns.
export async function listSharesWithGrants(req, warehouseId) {
  return sqlQuery(req, warehouseId,
    `SELECT s.share_name, s.share_owner, s.comment, s.created, s.created_by, s.last_altered, ` +
    `p.recipient_name, p.privilege_type, r.authentication_type, t.table_count ` +
    `FROM ${IS}.shares s ` +
    `LEFT JOIN ${IS}.share_recipient_privileges p ON p.share_name = s.share_name ` +
    `LEFT JOIN ${IS}.recipients r ON r.recipient_name = p.recipient_name ` +
    `LEFT JOIN (SELECT share_name, COUNT(*) AS table_count FROM ${IS}.table_share_usage GROUP BY share_name) t ` +
    `ON t.share_name = s.share_name ` +
    `ORDER BY s.share_name, p.recipient_name`);
}

export async function listRecipientsInfo(req, warehouseId) {
  return sqlQuery(req, warehouseId,
    `SELECT recipient_name, recipient_id, recipient_owner, authentication_type, comment, created, created_by ` +
    `FROM ${IS}.recipients ORDER BY recipient_name`);
}

// Group 'cat.schema.table' names by catalog. Lowercased, because
// information_schema stores identifiers in lower case.
function byCatalog(fullNames) {
  const m = new Map();
  for (const n of fullNames) {
    const parts = String(n).toLowerCase().split('.');
    if (parts.length !== 3) continue;
    const [cat, sch, tbl] = parts;
    if (!m.has(cat)) m.set(cat, { schemas: new Set(), tables: new Set(), full: new Set() });
    const e = m.get(cat);
    e.schemas.add(sch); e.tables.add(tbl); e.full.add(`${cat}.${sch}.${tbl}`);
  }
  return m;
}

async function mapLimitLocal(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

// Run one information_schema query per source catalog. The catalog-local
// views (<catalog>.information_schema) with plain equality filters answer
// in seconds. The metastore-wide system.information_schema views, joined
// unfiltered or filtered through expressions, took minutes on a large
// metastore (194s measured), so they are only a fallback here, still with
// equality filters on catalog, schema and table.
async function perCatalog(req, warehouseId, fullNames, build) {
  const groups = byCatalog(fullNames);
  const results = await mapLimitLocal(Array.from(groups.entries()), 4, async ([cat, g]) => {
    const schemas = Array.from(g.schemas).map(sqlStr).join(', ');
    const tables = Array.from(g.tables).map(sqlStr).join(', ');
    let rows;
    try {
      rows = await sqlQuery(req, warehouseId, build(`${idQ(cat)}.information_schema`, schemas, tables, null));
    } catch (e) {
      // Catalogs without their own information_schema fall back to the
      // system views.
      rows = await sqlQuery(req, warehouseId, build(IS, schemas, tables, sqlStr(cat)));
    }
    // schema IN (...) AND table IN (...) can match pairs that aren't in the
    // share; keep only the requested tables.
    return rows
      .map((r) => ({ ...r, _full: `${cat}.${String(r.table_schema).toLowerCase()}.${String(r.table_name).toLowerCase()}` }))
      .filter((r) => g.full.has(r._full));
  });
  return results.flat();
}

// Columns + UC primary key for a set of tables. One statement per source
// catalog (usually one in total). fullNames: ['cat.schema.table', ...].
// Returns Map(lowercased fullName -> { columns: [{name, type}], primaryKey }).
export async function getTablesColumnsAndPk(req, warehouseId, fullNames) {
  const rows = await perCatalog(req, warehouseId, fullNames, (isv, schemas, tables, catFilter) => {
    const catC = catFilter ? `AND c.table_catalog = ${catFilter} ` : '';
    const catT = catFilter ? `AND tc.table_catalog = ${catFilter} ` : '';
    return `SELECT c.table_schema, c.table_name, c.column_name, c.data_type, c.ordinal_position, ` +
      `pk.ordinal_position AS pk_position ` +
      `FROM ${isv}.columns c ` +
      `LEFT JOIN (SELECT kcu.table_schema, kcu.table_name, kcu.column_name, kcu.ordinal_position ` +
      `FROM ${isv}.table_constraints tc JOIN ${isv}.key_column_usage kcu ` +
      `ON tc.constraint_catalog = kcu.constraint_catalog AND tc.constraint_schema = kcu.constraint_schema ` +
      `AND tc.constraint_name = kcu.constraint_name ` +
      `WHERE tc.constraint_type = 'PRIMARY KEY' ${catT}AND tc.table_schema IN (${schemas}) AND tc.table_name IN (${tables})) pk ` +
      `ON pk.table_schema = c.table_schema AND pk.table_name = c.table_name AND pk.column_name = c.column_name ` +
      `WHERE c.table_schema IN (${schemas}) AND c.table_name IN (${tables}) ${catC}` +
      `ORDER BY c.table_schema, c.table_name, c.ordinal_position`;
  });
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r._full)) out.set(r._full, { columns: [], pk: [] });
    const t = out.get(r._full);
    t.columns.push({ name: r.column_name, type: r.data_type || null });
    if (r.pk_position != null) t.pk.push({ name: r.column_name, pos: Number(r.pk_position) });
  }
  for (const t of out.values()) {
    t.primaryKey = t.pk.sort((a, b) => a.pos - b.pos).map((x) => x.name);
    delete t.pk;
  }
  return out;
}

// Per-share summary for the dashboard and drift detection: table count,
// tables without a UC primary key, and the latest last_altered across the
// share's source tables. One statement for the share-to-table mapping, then
// one per source catalog.
export async function getShareSourceSummary(req, warehouseId, shareNames) {
  if (!shareNames.length) return [];
  const usage = await sqlQuery(req, warehouseId,
    `SELECT share_name, catalog_name, schema_name, table_name FROM ${IS}.table_share_usage ` +
    `WHERE share_name IN (${shareNames.map(sqlStr).join(', ')})`);
  const full = (u) => `${u.catalog_name}.${u.schema_name}.${u.table_name}`.toLowerCase();
  const meta = await perCatalog(req, warehouseId, usage.map(full), (isv, schemas, tables, catFilter) => {
    const catT = catFilter ? `AND t.table_catalog = ${catFilter} ` : '';
    const catK = catFilter ? `AND table_catalog = ${catFilter} ` : '';
    return `SELECT t.table_schema, t.table_name, t.last_altered, ` +
      `CASE WHEN pk.table_name IS NULL THEN 0 ELSE 1 END AS has_pk ` +
      `FROM ${isv}.tables t ` +
      `LEFT JOIN (SELECT DISTINCT table_schema, table_name FROM ${isv}.table_constraints ` +
      `WHERE constraint_type = 'PRIMARY KEY' ${catK}AND table_schema IN (${schemas}) AND table_name IN (${tables})) pk ` +
      `ON pk.table_schema = t.table_schema AND pk.table_name = t.table_name ` +
      `WHERE t.table_schema IN (${schemas}) AND t.table_name IN (${tables}) ${catT}`;
  }).catch((e) => { console.error('[dbx] source metadata failed', e.message); return []; });
  const byTable = new Map(meta.map((m) => [m._full, m]));
  const byShare = new Map();
  for (const u of usage) {
    const s = byShare.get(u.share_name) || { share_name: u.share_name, table_count: 0, source_last_altered: null, tables_without_pk: 0, metadata_complete: true };
    const m = byTable.get(full(u));
    s.table_count += 1;
    if (!m) s.metadata_complete = false;
    if (m && m.last_altered && (!s.source_last_altered || Date.parse(m.last_altered) > Date.parse(s.source_last_altered))) {
      s.source_last_altered = m.last_altered;
    }
    if (m && String(m.has_pk) !== '1') s.tables_without_pk += 1;
    byShare.set(u.share_name, s);
  }
  return Array.from(byShare.values());
}

// -----------------------------------------------------------------------------
// Pre-flight probes (SP)
// -----------------------------------------------------------------------------

// Can the app SP read every source table? One statement: a UNION of
// zero-row selects fails if any single table is not readable.
export async function spCanReadTables(warehouseId, fullNames) {
  if (!fullNames.length) return { ok: true };
  const parts = fullNames.map((n) => `SELECT 1 AS x FROM ${n.split('.').map(idQ).join('.')} WHERE 1 = 0`);
  try {
    await spExecuteStatement({ warehouseId, statement: parts.join(' UNION ALL ') });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Does the SDK secret scope exist and can the SP list it?
export async function spCheckSecretScope(scope) {
  try {
    const body = await spGet(`/api/2.0/secrets/list?scope=${encodeURIComponent(scope)}`);
    return { ok: true, keys: (body.secrets || []).map((s) => s.key) };
  } catch (e) {
    return { ok: false, status: e.status, error: e.message, code: e.code };
  }
}
