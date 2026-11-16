// The AI/BI dashboard, created and kept up to date by the app.
//
// The app SP creates the dashboard from dashboards/bdc_sharing.lvdash.json
// with the configured activity table written into the queries, publishes it
// with viewer credentials (each viewer queries with their own permissions),
// and gives the user who clicked CAN_MANAGE. The id is stored in the app's
// config file, so later clicks open or update the same dashboard.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getActivityTable, getAppSetting, setAppSettings } from '../config.js';
import { spApi } from '../dbx.js';
import { getWorkspaceHost } from '../auth.js';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dashboards', 'bdc_sharing.lvdash.json');
const DISPLAY_NAME = 'SAP BDC sharing';
const SHARED_FOLDER = '/Workspace/Shared/SAP BDC sharing';

async function template() {
  const raw = await fs.readFile(FILE, 'utf8');
  return { raw, version: crypto.createHash('sha1').update(raw).digest('hex').slice(0, 12) };
}

function fillTable(raw, table) {
  const fq = table.split('.').map((p) => '`' + p.replace(/`/g, '``') + '`').join('.');
  return raw.replace(/\bFROM activity\b/g, `FROM ${fq}`);
}

function dashboardUrl(id) {
  // The UI route is /dashboardsv3/...; the older /sql/dashboardsv3/ prefix
  // gives "page not found" on current workspaces.
  const o = process.env.DATABRICKS_WORKSPACE_ID;
  return `${getWorkspaceHost()}/dashboardsv3/${id}/published${o ? `?o=${encodeURIComponent(o)}` : ''}`;
}

export async function getAibiStatus() {
  const id = await getAppSetting('aibiDashboardId');
  if (!id) return { exists: false };
  try {
    const d = await spApi('GET', `/api/2.0/lakeview/dashboards/${encodeURIComponent(id)}`);
    if (d.lifecycle_state && d.lifecycle_state !== 'ACTIVE') return { exists: false, trashed: true };
    const { version } = await template();
    return {
      exists: true, id, url: dashboardUrl(id), path: d.path || null,
      outdated: (await getAppSetting('aibiTemplateVersion')) !== version,
      updatedAt: await getAppSetting('aibiUpdatedAt'),
    };
  } catch (e) {
    if (e.status === 404 || /does not exist|not found/i.test(e.message)) return { exists: false, deleted: true };
    throw e;
  }
}

async function parentFolder() {
  try {
    await spApi('POST', '/api/2.0/workspace/mkdirs', { path: SHARED_FOLDER });
    return SHARED_FOLDER;
  } catch {
    // Shared not writable for the SP: fall back to its own home folder.
    const dir = `/Workspace/Users/${process.env.DATABRICKS_CLIENT_ID}/bdc-publisher`;
    await spApi('POST', '/api/2.0/workspace/mkdirs', { path: dir });
    return dir;
  }
}

// Create the dashboard, or update the existing one to the shipped version.
// shareWith: optional group name that gets CAN_RUN.
export async function createOrUpdateAibi({ warehouseId, userEmail, shareWith }) {
  const table = await getActivityTable();
  if (!table) {
    const e = new Error('Set up the activity log first. The AI/BI dashboard reads from it.');
    e.status = 400; e.code = 'activity_not_configured'; throw e;
  }
  const { raw, version } = await template();
  const serialized = fillTable(raw, table);
  const status = await getAibiStatus().catch(() => ({ exists: false }));
  let id = status.exists ? status.id : null;
  let created = false;
  if (id) {
    await spApi('PATCH', `/api/2.0/lakeview/dashboards/${encodeURIComponent(id)}`, {
      display_name: DISPLAY_NAME, warehouse_id: warehouseId, serialized_dashboard: serialized,
    });
  } else {
    const parent = await parentFolder();
    const d = await spApi('POST', '/api/2.0/lakeview/dashboards', {
      display_name: DISPLAY_NAME, warehouse_id: warehouseId, serialized_dashboard: serialized, parent_path: parent,
    });
    id = d.dashboard_id;
    created = true;
  }
  await spApi('POST', `/api/2.0/lakeview/dashboards/${encodeURIComponent(id)}/published`, {
    embed_credentials: false, warehouse_id: warehouseId,
  });
  const acl = [];
  if (userEmail) acl.push({ user_name: userEmail, permission_level: 'CAN_MANAGE' });
  if (shareWith) acl.push({ group_name: shareWith, permission_level: 'CAN_RUN' });
  let shareError = null;
  if (acl.length) {
    try {
      await spApi('PATCH', `/api/2.0/permissions/dashboards/${encodeURIComponent(id)}`, { access_control_list: acl });
    } catch (e) { shareError = e.message; }
  }
  await setAppSettings({
    aibiDashboardId: id, aibiTemplateVersion: version,
    aibiUpdatedAt: new Date().toISOString(), aibiWarehouseId: warehouseId,
  });
  return { id, url: dashboardUrl(id), created, shareError };
}
