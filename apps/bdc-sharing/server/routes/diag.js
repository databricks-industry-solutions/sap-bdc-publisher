import { Router } from 'express';
import { getWorkspaceHost, getRequestUser, getUserToken } from '../auth.js';
import { getSpToken } from '../spAuth.js';
import {
  listWarehouses,
  listSharesRaw,
  listRecipientsRaw,
  showGrantsOnShare,
  sqlQuery,
} from '../dbx.js';

const router = Router();
const BDC_RE = /^bdc-connect-/i;

// Exact SQL statements the app runs. Surfaced so you can verify behaviour
// without reading the source.
const QUERIES = {
  listShares: 'SHOW SHARES',
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
    "SHOW GRANTS ON SHARE `<share_name>` — and the app treats a share as " +
    "`publishedToBdc` iff a row has principal matching /^bdc-connect-/i AND " +
    "action_type = 'SELECT'.",
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
    const whs = await listWarehouses();
    warehouseId = (whs.find((w) => w.enable_serverless_compute) || whs[0])?.id;
    out.checks.push({
      check: 'List warehouses (SP) — no SQL; REST /api/2.0/sql/warehouses',
      ok: true, count: whs.length,
      sample: whs.slice(0, 5).map((w) => ({
        id: w.id, name: w.name, size: w.cluster_size, state: w.state, serverless: !!w.enable_serverless_compute,
      })),
    });
  } catch (e) {
    out.checks.push({ check: 'List warehouses', ok: false, status: e.status, message: e.message, details: e.details });
  }

  if (warehouseId) {
    try {
      const shares = await listSharesRaw(req, warehouseId);
      out.checks.push({
        check: 'SHOW SHARES (user OBO)',
        sqlRun: QUERIES.listShares,
        ok: true, count: shares.length,
        sample: shares.slice(0, 3),
      });

      // Run SHOW GRANTS on every share so the panel shows the full picture.
      for (const s of shares) {
        const sqlRun = `SHOW GRANTS ON SHARE \`${s.name}\``;
        try {
          const grants = await showGrantsOnShare(req, warehouseId, s.name);
          const normalized = grants.map((g) => ({
            principal: g.recipient || g.Recipient || g.principal || g.Principal,
            action: g.privilege || g.action_type || g.ActionType,
            raw: g,
          }));
          const bdcMatches = normalized.filter((g) =>
            g.principal && BDC_RE.test(g.principal) && String(g.action).toUpperCase() === 'SELECT'
          );
          out.checks.push({
            check: `SHOW GRANTS ON SHARE \`${s.name}\``,
            sqlRun,
            ok: true,
            count: normalized.length,
            sample: normalized,
            publishedToBdc: bdcMatches.length > 0,
            bdcGrantPrincipals: bdcMatches.map((m) => m.principal),
            rule: "share is publishedToBdc iff any principal matches /^bdc-connect-/i AND action = 'SELECT'",
          });
        } catch (e) {
          out.checks.push({ check: `SHOW GRANTS ON SHARE \`${s.name}\``, sqlRun, ok: false, status: e.status, message: e.message, details: e.details });
        }
      }
    } catch (e) {
      out.checks.push({ check: 'SHOW SHARES', sqlRun: QUERIES.listShares, ok: false, status: e.status, message: e.message, details: e.details });
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
