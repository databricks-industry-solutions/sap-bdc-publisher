// Runtime config persistence. The activity table can be set at runtime via the
// in-app setup wizard (Activity tab), so app.yaml's BDC_ACTIVITY_TABLE env var
// is no longer the only source of truth.
//
// Resolution order (in getActivityTable):
//   1. process.env.BDC_ACTIVITY_TABLE (non-empty) — explicit override for
//      scripted deploys; if set, the wizard never persists.
//   2. In-process cache populated from previous reads.
//   3. Workspace JSON file at /Workspace/Users/<sp>/.bdc-app/config.json,
//      read via the SP token (workspace export API).
//   4. null — caller renders the wizard.
//
// The config file is owned by the app SP. We use the workspace import/export
// REST API rather than UC volumes so no extra catalog setup is required.

import { getSpToken } from './spAuth.js';
import { requireHost } from './auth.js';

const CONFIG_DIR = '.bdc-app';
const CONFIG_FILENAME = 'config.json';
const CONFIG_VERSION = 1;

const cache = {
  // null = not yet probed; { table: string|null, source: 'env'|'config'|null }
  resolved: null,
  spWorkspacePath: null,
};

function envTable() {
  const v = process.env.BDC_ACTIVITY_TABLE;
  return v && v.trim() ? v.trim() : null;
}

async function spFetch(urlPath, init = {}) {
  const host = requireHost();
  const token = await getSpToken();
  const res = await fetch(`${host}${urlPath}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  return res;
}

// Resolve the SP's workspace home path once. SCIM /Me as the SP returns the
// SP's userName; Apps SPs have a workspace folder at /Workspace/Users/<userName>.
async function resolveSpWorkspacePath() {
  if (cache.spWorkspacePath) return cache.spWorkspacePath;
  const res = await spFetch('/api/2.0/preview/scim/v2/Me');
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`SCIM Me (SP) failed: HTTP ${res.status} ${text}`);
    err.status = res.status;
    throw err;
  }
  const body = await res.json();
  const userName = body.userName;
  if (!userName) {
    const err = new Error('SCIM Me (SP) returned no userName');
    err.status = 500;
    throw err;
  }
  cache.spWorkspacePath = `/Workspace/Users/${userName}/${CONFIG_DIR}`;
  return cache.spWorkspacePath;
}

async function readConfigFile() {
  const dir = await resolveSpWorkspacePath();
  const filePath = `${dir}/${CONFIG_FILENAME}`;
  // workspace/export returns base64-encoded file content for AUTO format.
  const url = `/api/2.0/workspace/export?path=${encodeURIComponent(filePath)}&format=AUTO`;
  const res = await spFetch(url);
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // RESOURCE_DOES_NOT_EXIST surfaces as 400 with a body in some workspaces.
    if (text.includes('RESOURCE_DOES_NOT_EXIST') || text.includes('does not exist')) return null;
    const err = new Error(`workspace/export failed: HTTP ${res.status} ${text}`);
    err.status = res.status;
    throw err;
  }
  const body = await res.json();
  if (!body.content) return null;
  let json;
  try {
    const decoded = Buffer.from(body.content, 'base64').toString('utf8');
    json = JSON.parse(decoded);
  } catch (e) {
    console.error('[config] failed to parse config file', e.message);
    return null;
  }
  return json;
}

async function writeConfigFile(payload) {
  const dir = await resolveSpWorkspacePath();
  const filePath = `${dir}/${CONFIG_FILENAME}`;
  // Make the dir best-effort; mkdirs is idempotent.
  await spFetch('/api/2.0/workspace/mkdirs', {
    method: 'POST',
    body: JSON.stringify({ path: dir }),
  }).catch(() => {});

  const content = Buffer.from(JSON.stringify(payload, null, 2), 'utf8').toString('base64');
  const res = await spFetch('/api/2.0/workspace/import', {
    method: 'POST',
    body: JSON.stringify({
      path: filePath,
      format: 'AUTO',
      overwrite: true,
      content,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`workspace/import failed: HTTP ${res.status} ${text}`);
    err.status = res.status;
    throw err;
  }
}

// Returns { table: string|null, source: 'env'|'config'|null }.
async function resolve() {
  const e = envTable();
  if (e) return { table: e, source: 'env' };
  if (cache.resolved) return cache.resolved;
  try {
    const cfg = await readConfigFile();
    if (cfg && typeof cfg.activityTable === 'string' && cfg.activityTable.trim()) {
      cache.resolved = { table: cfg.activityTable.trim(), source: 'config' };
      return cache.resolved;
    }
  } catch (err) {
    // Best-effort: never block the app on a config-file read failure.
    console.error('[config] readConfigFile failed', err.message);
  }
  cache.resolved = { table: null, source: null };
  return cache.resolved;
}

export async function getActivityTable() {
  const r = await resolve();
  return r.table;
}

export async function getActivityConfig() {
  return resolve();
}

export async function setActivityTable({ table, configuredBy }) {
  if (!table || typeof table !== 'string') {
    throw new Error('setActivityTable requires a non-empty table name');
  }
  const payload = {
    version: CONFIG_VERSION,
    activityTable: table,
    configuredBy: configuredBy || null,
    configuredAt: new Date().toISOString(),
  };
  await writeConfigFile(payload);
  // Refresh cache. If env var is set it still wins on next read.
  cache.resolved = envTable() ? { table: envTable(), source: 'env' } : { table, source: 'config' };
  return cache.resolved;
}

// Used by tests/dev to drop the cache and re-read.
export function _resetConfigCache() {
  cache.resolved = null;
  cache.spWorkspacePath = null;
}
