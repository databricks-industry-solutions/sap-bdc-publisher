// Setup check. One list of checks that the Setup page shows, and that the
// app enforces before anyone can publish or unpublish (unless
// BDC_REQUIRE_ACTIVITY_LOG=false).
//
// Levels:
//   required     publishing is blocked until it passes
//   recommended  the app works, but the Activity page or Dashboards are
//                incomplete for some users
//   optional     extra features (SAP read KPIs, AI/BI dashboard)

import crypto from 'node:crypto';
import { spExecuteStatement, executeStatement, idQ } from '../dbx.js';
import { getActivityConfig } from '../config.js';
import { getActivityColumns, forgetActivityColumns, V2_COLUMNS } from '../activity.js';
import { getAibiStatus } from './aibi.js';
import { requireRequestUser } from '../auth.js';

const OK_TTL_MS = 10 * 60_000;
let requiredOkUntil = 0;
let requiredOkTable = null;

export function activityLogRequired() {
  return String(process.env.BDC_REQUIRE_ACTIVITY_LOG || 'true').toLowerCase() !== 'false';
}

function fq(table) { return table.split('.').map(idQ).join('.'); }
function spName() { return process.env.DATABRICKS_CLIENT_ID || '<app-sp-client-id>'; }

function grantSql(table) {
  const [c, s] = table.split('.');
  const sp = idQ(spName());
  return [
    `GRANT USE CATALOG ON CATALOG ${idQ(c)} TO ${sp}`,
    `GRANT USE SCHEMA ON SCHEMA ${idQ(c)}.${idQ(s)} TO ${sp}`,
    `GRANT SELECT, MODIFY ON TABLE ${fq(table)} TO ${sp}`,
  ];
}

function looksLikeWarehouseDenied(msg) {
  return /warehouse/i.test(msg) && /(permission|not authorized|CAN_USE|access)/i.test(msg);
}

// Insert and delete one probe row as the SP. Proves the full write path the
// activity log uses, including the warehouse.
async function spWriteProbe(table, warehouseId) {
  const id = crypto.randomUUID();
  await spExecuteStatement({
    warehouseId,
    statement: `INSERT INTO ${fq(table)} (event_id, event_time, event_type, user_email, action, share_name, recipient_name, metadata_json) ` +
      `VALUES (:id, current_timestamp(), 'wizard_adopt_probe', 'setup-check', 'setup', '', '', '{"probe":true}')`,
    parameters: [{ name: 'id', value: id, type: 'STRING' }],
  });
  await spExecuteStatement({
    warehouseId,
    statement: `DELETE FROM ${fq(table)} WHERE event_id = :id`,
    parameters: [{ name: 'id', value: id, type: 'STRING' }],
  }).catch(() => { /* a leftover probe row is filtered everywhere */ });
}

async function requiredChecks(warehouseId) {
  const checks = [];
  const { table, source } = await getActivityConfig();
  if (!table) {
    checks.push({
      id: 'activity_configured', level: 'required', status: 'fail', label: 'Activity log configured',
      detail: 'No activity table is set. Create one or adopt an existing one on the Activity page.',
      action: { kind: 'link', label: 'Set up activity log', href: '/activity.html' },
    });
    return { checks, table: null };
  }
  checks.push({
    id: 'activity_configured', level: 'required', status: 'ok', label: 'Activity log configured',
    detail: `Logging to ${table} (set ${source === 'env' ? 'in app.yaml' : 'in the app'}).`,
  });

  // Read and write as the app SP, on the warehouse the user is using.
  try {
    await spExecuteStatement({ warehouseId, statement: `SELECT * FROM ${fq(table)} LIMIT 0` });
    await spWriteProbe(table, warehouseId);
    checks.push({ id: 'sp_access', level: 'required', status: 'ok', label: 'App can write the activity log', detail: 'The app service principal can read and write the table on this warehouse.' });
  } catch (e) {
    const wh = looksLikeWarehouseDenied(e.message);
    checks.push({
      id: 'sp_access', level: 'required', status: 'fail', label: 'App can write the activity log',
      detail: wh
        ? `The app service principal can't use this SQL warehouse: ${e.message}`
        : `The app service principal can't read and write ${table}: ${e.message}`,
      sql: wh ? null : grantSql(table),
      cli: wh ? [`databricks warehouses update-permissions ${warehouseId} --json '{"access_control_list":[{"service_principal_name":"${spName()}","permission_level":"CAN_USE"}]}'`] : null,
    });
  }
  return { checks, table };
}

// Fast path for the publish/unpublish gate: required checks only, cached
// after a pass.
export async function assertReady(warehouseId) {
  if (!activityLogRequired()) return;
  const { table } = await getActivityConfig();
  if (table && table === requiredOkTable && Date.now() < requiredOkUntil) return;
  const { checks } = await requiredChecks(warehouseId);
  const failed = checks.filter((c) => c.status !== 'ok');
  if (failed.length) {
    const err = new Error(`The app isn't set up yet: ${failed.map((c) => c.label).join(', ')}. Open the Setup page to fix it.`);
    err.status = 412; err.code = 'setup_incomplete'; err.details = { checks: failed };
    throw err;
  }
  requiredOkTable = table;
  requiredOkUntil = Date.now() + OK_TTL_MS;
}

export function forgetReadiness() { requiredOkUntil = 0; requiredOkTable = null; }

export async function computeReadiness(req, warehouseId) {
  requireRequestUser(req);
  const { checks, table } = await requiredChecks(warehouseId);
  const requiredOk = checks.every((c) => c.status === 'ok');
  if (requiredOk && table) { requiredOkTable = table; requiredOkUntil = Date.now() + OK_TTL_MS; }

  if (table) {
    // v2 columns
    try {
      forgetActivityColumns();
      const cols = await getActivityColumns(table, warehouseId);
      const missing = V2_COLUMNS.filter((c) => !cols.has(c.name)).map((c) => c.name);
      checks.push(missing.length
        ? { id: 'columns_v2', level: 'recommended', status: 'warn', label: 'Activity table up to date',
            detail: `Missing columns from app v2: ${missing.join(', ')}. The table owner can add them.`,
            action: { kind: 'migrate', label: 'Add columns' } }
        : { id: 'columns_v2', level: 'recommended', status: 'ok', label: 'Activity table up to date', detail: 'All columns present.' });
    } catch {
      checks.push({ id: 'columns_v2', level: 'recommended', status: 'warn', label: 'Activity table up to date', detail: 'Could not read the table columns.' });
    }

    // Can people read their own history? Checked as the current user.
    try {
      await executeStatement(req, { warehouseId, statement: `SELECT * FROM ${fq(table)} LIMIT 0` });
      checks.push({ id: 'viewer_read', level: 'recommended', status: 'ok', label: 'Users can read the activity log',
        detail: 'You can read the table. Others need the same grant to see the Activity page and dashboards.' });
    } catch (e) {
      checks.push({ id: 'viewer_read', level: 'recommended', status: 'warn', label: 'Users can read the activity log',
        detail: `You can't read ${table}, so the Activity page and the publishing KPIs stay empty for you. ` +
          'Grant SELECT to the users who should see them (all of them reads every row in DBSQL).',
        sql: [`GRANT SELECT ON TABLE ${fq(table)} TO \`account users\``] });
    }
  }

  // SAP read KPIs (optional)
  try {
    await spExecuteStatement({ warehouseId, statement: 'SELECT 1 FROM system.access.audit WHERE 1 = 0' });
    checks.push({ id: 'audit', level: 'optional', status: 'ok', label: 'SAP read KPIs', detail: 'The app can read Delta Sharing events from system.access.audit.' });
  } catch {
    const sp = idQ(spName());
    checks.push({ id: 'audit', level: 'optional', status: 'warn', label: 'SAP read KPIs',
      detail: 'The app can\'t read system.access.audit, so the Dashboard has no SAP read activity. A metastore admin can grant it. The app SP can then read the whole audit table.',
      sql: [`GRANT USE CATALOG ON CATALOG system TO ${sp}`, `GRANT USE SCHEMA ON SCHEMA system.access TO ${sp}`, `GRANT SELECT ON TABLE system.access.audit TO ${sp}`] });
  }

  // AI/BI dashboard (optional)
  const aibi = await getAibiStatus().catch(() => ({ exists: false }));
  if (aibi.exists) {
    checks.push({ id: 'aibi', level: 'optional', status: aibi.outdated ? 'warn' : 'ok', label: 'AI/BI dashboard',
      detail: aibi.outdated ? 'Created, but this app version ships a newer dashboard.' : 'Created and published.',
      action: aibi.outdated ? { kind: 'aibi', label: 'Update dashboard' } : { kind: 'link', label: 'Open', href: aibi.url, external: true } });
  } else {
    checks.push({ id: 'aibi', level: 'optional', status: table ? 'warn' : 'wait', label: 'AI/BI dashboard',
      detail: table ? 'Not created yet. One click creates and publishes it with your activity table and this warehouse.' : 'Needs the activity log first.',
      action: table ? { kind: 'aibi', label: 'Create AI/BI dashboard' } : null });
  }

  return {
    ready: requiredOk,
    enforced: activityLogRequired(),
    table,
    spClientId: process.env.DATABRICKS_CLIENT_ID || null,
    checks,
  };
}
