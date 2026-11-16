import { Router } from 'express';
import { getWorkspaceHost, getRequestUser, getUserToken } from '../auth.js';
import { getSpToken } from '../spAuth.js';
import {
  listWarehouses,
  listSharesRaw,
  listRecipientsRaw,
  showGrantsOnShare,
  listSharesWithGrants,
} from '../dbx.js';
import { isBdcRecipient, bdcRecipientPattern } from '../bdc.js';
import { mapLimit } from '../lib/budget.js';

const router = Router();
const PARITY_SAMPLE = 10;

// Exact SQL statements the app runs. Surfaced so you can verify behaviour
// without reading the source.
const QUERIES = {
  listSharesV2:
    'SELECT s.share_name, s.share_owner, p.recipient_name, p.privilege_type, r.authentication_type, t.table_count ' +
    'FROM system.information_schema.shares s ' +
    'LEFT JOIN system.information_schema.share_recipient_privileges p ON p.share_name = s.share_name ' +
    'LEFT JOIN system.information_schema.recipients r ON r.recipient_name = p.recipient_name ' +
    'LEFT JOIN (SELECT share_name, COUNT(*) table_count FROM system.information_schema.table_share_usage GROUP BY share_name) t ' +
    'ON t.share_name = s.share_name',
  listShares: 'SHOW SHARES (fallback only)',
  listRecipients: 'SHOW RECIPIENTS',
  describeShare: 'DESCRIBE SHARE `<share_name>`',
  showAllInShare: 'SHOW ALL IN SHARE `<share_name>`',
  showGrantsOnShare: 'SHOW GRANTS ON SHARE `<share_name>`',
  showGrantsOnRecipient: 'SHOW GRANTS ON RECIPIENT `<recipient_name>`',
  describeTable: 'DESCRIBE TABLE `<catalog>`.`<schema>`.`<table>`',
  pkLookup:
    "SELECT kcu.column_name, kcu.ordinal_position " +
    "FROM system.information_schema.table_constraints tc " +
    "JOIN system.information_schema.key_column_usage kcu " +
    "ON tc.constraint_catalog = kcu.constraint_catalog " +
    "AND tc.constraint_schema = kcu.constraint_schema " +
    "AND tc.constraint_name = kcu.constraint_name " +
    "WHERE tc.constraint_type = 'PRIMARY KEY' " +
    "AND tc.table_catalog = '<catalog>' " +
    "AND tc.table_schema = '<schema>' " +
    "AND tc.table_name = '<table>' " +
    "ORDER BY kcu.ordinal_position",
  publishedCheck:
    'A share is in BDC if a recipient whose name matches the BDC pattern ' +
    'holds SELECT on it (from share_recipient_privileges).',
};

router.get('/', async (req, res) => {
  const out = {
    env: {
      DATABRICKS_HOST: getWorkspaceHost() || null,
      DATABRICKS_CLIENT_ID: process.env.DATABRICKS_CLIENT_ID ? (process.env.DATABRICKS_CLIENT_ID.slice(0, 8) + '…') : null,
      DATABRICKS_CLIENT_SECRET: process.env.DATABRICKS_CLIENT_SECRET ? 'set' : 'missing',
      DATABRICKS_APP_NAME: process.env.DATABRICKS_APP_NAME || null,
      BDC_NOTEBOOK_PATH: process.env.BDC_NOTEBOOK_PATH || null,
    },
    forwardedUser: getRequestUser(req),
    userTokenPresent: !!req.header('x-forwarded-access-token'),
    queries: QUERIES,
    checks: [],
  };

  try {
    const t = await getSpToken();
    out.spTokenPrefix = t ? t.slice(0, 12) + '…' : null;
    out.checks.push({ check: 'App SP token (client_credentials)', ok: true });
  } catch (e) {
    out.checks.push({ check: 'App SP token', ok: false, status: e.status, message: e.message, details: e.details });
  }

  try {
    getUserToken(req);
    out.checks.push({ check: 'User OBO token (x-forwarded-access-token)', ok: true });
  } catch (e) {
    out.checks.push({ check: 'User OBO token', ok: false, status: e.status, message: e.message });
  }

  let warehouseId;
  try {
    const whs = await listWarehouses(req);
    warehouseId = (whs.find((w) => w.enable_serverless_compute) || whs[0])?.id;
    out.checks.push({
      check: 'List warehouses (user OBO) — no SQL; REST /api/2.0/sql/warehouses',
      ok: true, count: whs.length,
      sample: whs.slice(0, 5).map((w) => ({
        id: w.id, name: w.name, size: w.cluster_size, state: w.state, serverless: !!w.enable_serverless_compute,
      })),
    });
  } catch (e) {
    out.checks.push({ check: 'List warehouses', ok: false, status: e.status, message: e.message, details: e.details });
  }

  if (warehouseId) {
    // v2 listing query, plus a parity check against SHOW GRANTS ON SHARE on
    // a sample of shares. This answers whether information_schema shows the
    // same BDC grants as the SHOW command (PRD open question Q3).
    let v2Rows = null;
    try {
      v2Rows = await listSharesWithGrants(req, warehouseId);
      out.checks.push({
        check: 'information_schema share listing (user OBO)',
        sqlRun: QUERIES.listSharesV2,
        ok: true, count: v2Rows.length, sample: v2Rows.slice(0, 5),
        rule: `BDC recipient pattern: /${bdcRecipientPattern()}/i`,
      });
    } catch (e) {
      out.checks.push({ check: 'information_schema share listing', sqlRun: QUERIES.listSharesV2, ok: false, status: e.status, message: e.message, details: e.details });
    }
    try {
      const shares = await listSharesRaw(req, warehouseId);
      out.checks.push({ check: 'SHOW SHARES (user OBO)', sqlRun: 'SHOW SHARES', ok: true, count: shares.length, sample: shares.slice(0, 3) });
      if (v2Rows) {
        const v2Bdc = new Map();
        for (const r of v2Rows) {
          if (!v2Bdc.has(r.share_name)) v2Bdc.set(r.share_name, new Set());
          if (r.recipient_name && String(r.privilege_type).toUpperCase() === 'SELECT' && isBdcRecipient(r.recipient_name)) {
            v2Bdc.get(r.share_name).add(r.recipient_name);
          }
        }
        const sample = shares.slice(0, PARITY_SAMPLE);
        const diffs = await mapLimit(sample, 4, async (sh) => {
          const grants = await showGrantsOnShare(req, warehouseId, sh.name).catch(() => null);
          if (!grants) return { share: sh.name, error: 'SHOW GRANTS failed' };
          const show = new Set(grants
            .filter((g) => String(g.privilege || g.action_type || '').toUpperCase() === 'SELECT')
            .map((g) => g.recipient || g.principal)
            .filter((n) => n && isBdcRecipient(n)));
          const is = v2Bdc.get(sh.name) || new Set();
          const onlyShow = [...show].filter((n) => !is.has(n));
          const onlyIs = [...is].filter((n) => !show.has(n));
          return { share: sh.name, inInformationSchema: v2Bdc.has(sh.name), onlyShow, onlyIs };
        });
        const mismatches = diffs.filter((d) => d.error || !d.inInformationSchema || d.onlyShow.length || d.onlyIs.length);
        out.checks.push({
          check: `Parity: information_schema vs SHOW GRANTS (${sample.length} share sample)`,
          ok: mismatches.length === 0,
          message: mismatches.length ? `${mismatches.length} share(s) differ` : undefined,
          count: sample.length,
          sample: mismatches.length ? mismatches : diffs.slice(0, 3),
        });
      }
    } catch (e) {
      out.checks.push({ check: 'SHOW SHARES', sqlRun: 'SHOW SHARES', ok: false, status: e.status, message: e.message, details: e.details });
    }

    try {
      const recs = await listRecipientsRaw(req, warehouseId);
      out.checks.push({
        check: 'SHOW RECIPIENTS (user OBO)',
        sqlRun: QUERIES.listRecipients,
        ok: true, count: recs.length, sample: recs.slice(0, 3),
      });
    } catch (e) {
      out.checks.push({ check: 'SHOW RECIPIENTS', sqlRun: QUERIES.listRecipients, ok: false, status: e.status, message: e.message, details: e.details });
    }
  }

  res.json(out);
});

export default router;
