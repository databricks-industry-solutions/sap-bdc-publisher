// First-run setup wizard for the activity log. The Activity tab opens onto
// a setup card whenever no activity table is configured (env var unset and
// no workspace config file written yet).
//
// Two paths in the wizard:
//   - Provision and enable: runs DDL as the user via OBO (CREATE SCHEMA,
//     CREATE TABLE, GRANTs to the app SP). Requires MANAGE on the catalog
//     since granting USE CATALOG to the SP requires it.
//   - Adopt an existing table: catalog admin has provisioned everything
//     externally; the wizard probes read+write access as the app SP and
//     persists the path if the probe passes. Requires no UC privileges
//     from the user beyond what the SP already has on the table.
//
// Both paths persist the chosen 3-part name to a workspace config file
// owned by the app SP — getActivityTable() resolves it on every request.

import { Router } from 'express';
import { sqlQuery, executeStatement, spExecuteStatement } from '../dbx.js';
import { requireRequestUser } from '../auth.js';
import { getActivityConfig, setActivityTable } from '../config.js';
import crypto from 'node:crypto';

const router = Router();

// UC identifier safety. Object names are user-supplied via the wizard form,
// so we restrict to a strict allowlist before SQL interpolation. UC itself
// allows more characters in backtick-quoted names, but the allowlist is
// intentionally conservative — every well-known catalog/schema/table fits.
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/;
function validName(s, label) {
  if (!s || !NAME_RE.test(s)) {
    const err = new Error(
      `Invalid ${label} name "${s}". Use letters, digits, underscores, or hyphens (1–128 chars, must start with a letter/digit/underscore).`
    );
    err.status = 400;
    err.code = 'invalid_identifier';
    throw err;
  }
}
function idQ(name) { return '`' + String(name).replace(/`/g, '``') + '`'; }

function parseFqTable(table) {
  const parts = String(table || '').split('.');
  if (parts.length !== 3) {
    const err = new Error('Table must be a 3-part name: <catalog>.<schema>.<table>');
    err.status = 400; err.code = 'invalid_table_name'; throw err;
  }
  validName(parts[0], 'catalog');
  validName(parts[1], 'schema');
  validName(parts[2], 'table');
  return { catalog: parts[0], schema: parts[1], table: parts[2] };
}

// GET /api/setup/activity-status
// UI calls this on every Activity tab load to choose the render state.
router.get('/activity-status', async (req, res, next) => {
  try {
    const { table, source } = await getActivityConfig();
    res.json({
      configured: !!table,
      table: table || null,
      source: source || null,
      // SP client ID exposed so the wizard's lockout state can render a
      // copy-paste-ready provisioning SQL block for the catalog admin
      // (no `<placeholder>`s for them to fill in).
      spClientId: process.env.DATABRICKS_CLIENT_ID || null,
    });
  } catch (err) { next(err); }
});

// GET /api/setup/catalogs?warehouseId=...
// Lists catalogs visible to the user, with hasManage flagged per-catalog so
// the wizard can disable rows the user can't grant on. We probe MANAGE by
// running SHOW GRANTS ON CATALOG <c> as the user — the statement requires
// MANAGE / OWNER, so success === has-MANAGE. Probes run in parallel to keep
// total latency low even with a dozen catalogs.
router.get('/catalogs', async (req, res, next) => {
  try {
    requireRequestUser(req);
    const warehouseId = String(req.query.warehouseId || '');
    if (!warehouseId) {
      const err = new Error('warehouseId is required');
      err.status = 400; throw err;
    }
    const rows = await sqlQuery(req, warehouseId, 'SHOW CATALOGS').catch(() => []);
    const names = rows
      .map((r) => r.catalog || r.catalog_name)
      .filter(Boolean)
      // Hide catalogs no one provisions schemas in.
      .filter((n) => n !== 'system' && n !== '__databricks_internal' && n !== 'samples');

    const probes = await Promise.all(names.map(async (name) => {
      try {
        await sqlQuery(req, warehouseId, `SHOW GRANTS ON CATALOG ${idQ(name)}`);
        return { name, hasManage: true };
      } catch (_e) {
        return { name, hasManage: false };
      }
    }));

    res.json({ catalogs: probes });
  } catch (err) { next(err); }
});

// POST /api/setup/activity
// Body: { catalog, schema, table, warehouseId }
// Self-serve provisioning path: runs the DDL chain as the user via OBO,
// then persists the chosen table.
router.post('/activity', async (req, res, next) => {
  try {
    const user = requireRequestUser(req);

    // Once a destination is set (via wizard or env var), the API will not
    // overwrite it. Relocate by editing the SP-owned config.json or by
    // setting BDC_ACTIVITY_TABLE in app.yaml.
    const existing = await getActivityConfig();
    if (existing.table) {
      return res.status(409).json({
        ok: false,
        code: 'already_configured',
        table: existing.table,
        source: existing.source,
        message:
          `Activity log destination is already set to ${existing.table} ` +
          `(source: ${existing.source}). It cannot be changed via the API.`,
      });
    }

    const { catalog, schema, table, warehouseId } = req.body || {};
    if (!warehouseId) {
      const err = new Error('warehouseId is required'); err.status = 400; throw err;
    }
    validName(catalog, 'catalog');
    validName(schema, 'schema');
    validName(table, 'table');

    const spId = process.env.DATABRICKS_CLIENT_ID;
    if (!spId) {
      const err = new Error('DATABRICKS_CLIENT_ID is not set — cannot resolve the app service principal.');
      err.status = 500; err.code = 'missing_sp_client_id'; throw err;
    }

    const cQ = idQ(catalog);
    const sQ = idQ(schema);
    const tQ = idQ(table);
    const fqSchema = `${cQ}.${sQ}`;
    const fqTable = `${cQ}.${sQ}.${tQ}`;
    const fqDot = `${catalog}.${schema}.${table}`;
    const spQ = idQ(spId);

    // `required: true` halts the chain on failure (the app can't function
    // without these). `required: false` is a nice-to-have — failures get
    // marked 'skipped' (yellow) and the chain proceeds. The History panel
    // reads as the user via OBO, and `account users` is a UC built-in
    // group so its grant should always succeed; required:false only
    // matters in workspace edge cases where the group is restricted.
    const steps = [
      {
        name: 'Create schema',
        required: true,
        sql: `CREATE SCHEMA IF NOT EXISTS ${fqSchema}`,
      },
      {
        name: 'Create table',
        required: true,
        sql:
          `CREATE TABLE IF NOT EXISTS ${fqTable} (` +
          `event_id STRING NOT NULL, event_time TIMESTAMP NOT NULL, ` +
          `event_type STRING NOT NULL, user_email STRING NOT NULL, ` +
          `action STRING NOT NULL, share_name STRING NOT NULL, ` +
          `recipient_name STRING NOT NULL, run_id STRING, warehouse_id STRING, ` +
          `error_code STRING, error_message STRING, metadata_json STRING, ` +
          `app_deployment STRING, ` +
          `event_date DATE GENERATED ALWAYS AS (CAST(event_time AS DATE))) ` +
          `USING DELTA PARTITIONED BY (event_date)`,
      },
      { name: 'Grant USE CATALOG to app SP',  required: true, sql: `GRANT USE CATALOG ON CATALOG ${cQ} TO ${spQ}` },
      { name: 'Grant USE SCHEMA to app SP',   required: true, sql: `GRANT USE SCHEMA ON SCHEMA ${fqSchema} TO ${spQ}` },
      { name: 'Grant SELECT, MODIFY to app SP', required: true, sql: `GRANT SELECT, MODIFY ON TABLE ${fqTable} TO ${spQ}` },
      { name: 'Grant SELECT to account users (optional)', required: false, sql: `GRANT SELECT ON TABLE ${fqTable} TO \`account users\`` },
    ];

    const results = [];
    for (const step of steps) {
      try {
        await executeStatement(req, { statement: step.sql, warehouseId });
        results.push({ name: step.name, status: 'ok' });
      } catch (e) {
        if (step.required) {
          results.push({ name: step.name, status: 'failed', error: e.message, sql: step.sql });
          return res.status(400).json({
            ok: false,
            table: fqDot,
            steps: results,
            message: `Provisioning halted at "${step.name}": ${e.message}`,
          });
        }
        results.push({ name: step.name, status: 'skipped', error: e.message });
      }
    }

    let persisted;
    try {
      persisted = await setActivityTable({ table: fqDot, configuredBy: user.email || user.userName });
    } catch (e) {
      results.push({ name: 'Save app config', status: 'failed', error: e.message });
      return res.status(500).json({
        ok: false,
        table: fqDot,
        steps: results,
        message: `Provisioning succeeded but saving app config failed: ${e.message}. Re-run the wizard to retry.`,
      });
    }
    results.push({ name: 'Save app config', status: 'ok' });

    res.json({
      ok: true,
      table: persisted.table,
      source: persisted.source,
      steps: results,
    });
  } catch (err) { next(err); }
});

// POST /api/setup/adopt-activity
// Body: { table, warehouseId }  — `table` is the fully-qualified 3-part name
// of an externally-provisioned activity table.
//
// Verifies that the app SP can read+write to the table by running three
// statements as the SP (not OBO):
//   1. SELECT * FROM <t> LIMIT 0  → confirms USE CATALOG/SCHEMA + SELECT
//   2. INSERT INTO <t> (…)        → confirms MODIFY (probe row)
//   3. DELETE FROM <t> WHERE event_id = <probe_id>  → cleans up the probe
//
// If all three pass, persists the path. Otherwise returns the UC error so
// the user can hand it to their catalog admin.
router.post('/adopt-activity', async (req, res, next) => {
  try {
    const user = requireRequestUser(req);

    const existing = await getActivityConfig();
    if (existing.table) {
      return res.status(409).json({
        ok: false,
        code: 'already_configured',
        table: existing.table,
        source: existing.source,
        message:
          `Activity log destination is already set to ${existing.table} ` +
          `(source: ${existing.source}). It cannot be changed via the API.`,
      });
    }

    const { table, warehouseId } = req.body || {};
    if (!warehouseId) {
      const err = new Error('warehouseId is required'); err.status = 400; throw err;
    }
    const parts = parseFqTable(table);
    const cQ = idQ(parts.catalog);
    const sQ = idQ(parts.schema);
    const tQ = idQ(parts.table);
    const fqTable = `${cQ}.${sQ}.${tQ}`;
    const fqDot = `${parts.catalog}.${parts.schema}.${parts.table}`;
    const probeId = crypto.randomUUID();

    const probes = [];

    // 1. SELECT probe.
    try {
      await spExecuteStatement({ statement: `SELECT * FROM ${fqTable} LIMIT 0`, warehouseId });
      probes.push({ name: 'SP can read table', status: 'ok' });
    } catch (e) {
      probes.push({ name: 'SP can read table', status: 'failed', error: e.message });
      return res.status(400).json({
        ok: false, table: fqDot, probes,
        message: `App SP cannot read ${fqDot}. Ask the catalog admin to grant USE CATALOG / USE SCHEMA / SELECT to the SP.`,
      });
    }

    // 2. INSERT probe — tag with metadata so it's recognizable if the
    //    DELETE step fails for any reason.
    const insertParams = [
      { name: 'event_id',      value: probeId, type: 'STRING' },
      { name: 'event_type',    value: 'wizard_adopt_probe', type: 'STRING' },
      { name: 'user_email',    value: user.email || user.userName || '', type: 'STRING' },
      { name: 'action',        value: 'adopt', type: 'STRING' },
      { name: 'share_name',    value: '', type: 'STRING' },
      { name: 'recipient_name', value: '', type: 'STRING' },
      { name: 'metadata_json', value: '{"probe":true}', type: 'STRING' },
    ];
    const insertSql =
      `INSERT INTO ${fqTable} (` +
      `event_id, event_time, event_type, user_email, action, share_name, recipient_name, metadata_json) VALUES (` +
      `:event_id, current_timestamp(), :event_type, :user_email, :action, :share_name, :recipient_name, :metadata_json)`;
    try {
      await spExecuteStatement({ statement: insertSql, warehouseId, parameters: insertParams });
      probes.push({ name: 'SP can write to table', status: 'ok' });
    } catch (e) {
      probes.push({ name: 'SP can write to table', status: 'failed', error: e.message });
      return res.status(400).json({
        ok: false, table: fqDot, probes,
        message: `App SP cannot write to ${fqDot}. Ask the catalog admin to grant MODIFY on the table to the SP.`,
      });
    }

    // 3. DELETE the probe row. If this fails the probe row stays — that's
    //    cosmetic, not blocking. We still persist and surface a soft note.
    try {
      await spExecuteStatement({
        statement: `DELETE FROM ${fqTable} WHERE event_id = :event_id`,
        warehouseId,
        parameters: [{ name: 'event_id', value: probeId, type: 'STRING' }],
      });
      probes.push({ name: 'Cleaned up probe row', status: 'ok' });
    } catch (e) {
      probes.push({ name: 'Cleaned up probe row', status: 'skipped', error: e.message });
    }

    let persisted;
    try {
      persisted = await setActivityTable({ table: fqDot, configuredBy: user.email || user.userName });
    } catch (e) {
      probes.push({ name: 'Save app config', status: 'failed', error: e.message });
      return res.status(500).json({
        ok: false, table: fqDot, probes,
        message: `Probe passed but saving app config failed: ${e.message}.`,
      });
    }
    probes.push({ name: 'Save app config', status: 'ok' });

    res.json({
      ok: true,
      table: persisted.table,
      source: persisted.source,
      probes,
    });
  } catch (err) { next(err); }
});

export default router;
