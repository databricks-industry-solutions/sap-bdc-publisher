import { Router } from 'express';
import {
  showGrantsOnShare,
  showGrantsOnRecipient,
  describeShare,
  describeRecipient,
  showAllInShare,
  executeStatement,
} from '../dbx.js';
import { getRequestUser } from '../auth.js';

const router = Router();
function norm(s) { return String(s || '').toLowerCase(); }
function idQ(name) { return '`' + String(name).replace(/`/g, '``') + '`'; }

router.get('/check', async (req, res, next) => {
  try {
    const warehouseId = String(req.query.warehouseId || '');
    const share = String(req.query.share || '');
    const recipient = String(req.query.recipient || '');
    if (!warehouseId || !share || !recipient) {
      const e = new Error('warehouseId, share and recipient query params are required');
      e.status = 400; throw e;
    }
    const user = getRequestUser(req);
    const userEmail = norm(user.userName || user.email);

    const [shareDesc, recipientDesc, shareGrants, recipientGrants] = await Promise.all([
      describeShare(req, warehouseId, share),
      describeRecipient(req, warehouseId, recipient),
      showGrantsOnShare(req, warehouseId, share).catch(() => []),
      showGrantsOnRecipient(req, warehouseId, recipient).catch(() => []),
    ]);
    const shareOwner = (shareDesc[0] || {}).owner || null;
    const recipientOwner = (recipientDesc[0] || {}).owner || null;

    function filterMine(grants) {
      const out = [];
      for (const g of grants) {
        const principal = g.recipient || g.Recipient || g.principal || g.Principal;
        const priv = String(g.privilege || g.action_type || g.ActionType || '').toUpperCase();
        if (principal && norm(principal) === userEmail && priv) out.push(priv);
      }
      return out;
    }

    res.json({
      user: user.userName,
      share: {
        name: share, owner: shareOwner,
        isOwner: shareOwner && norm(shareOwner) === userEmail,
        privileges: filterMine(shareGrants),
      },
      recipient: {
        name: recipient, owner: recipientOwner,
        isOwner: recipientOwner && norm(recipientOwner) === userEmail,
        privileges: filterMine(recipientGrants),
      },
    });
  } catch (err) { next(err); }
});

// Grants the app SP USE CATALOG / USE SCHEMA / SELECT on every catalog,
// schema, and table backing the share. Required because the BDC publish job
// runs as the SP after run-as removal — without UC access on the source,
// csn_generator + publish_data_product fail. Runs as the user via OBO; the
// caller must hold MANAGE / GRANT on the catalog (typically the share owner
// already does).
router.post('/sp-catalog', async (req, res, next) => {
  try {
    const { shareName, warehouseId } = req.body || {};
    if (!shareName || !warehouseId) {
      const err = new Error('shareName and warehouseId are required');
      err.status = 400; throw err;
    }
    const spId = process.env.DATABRICKS_CLIENT_ID;
    if (!spId) {
      const err = new Error('DATABRICKS_CLIENT_ID is not set — cannot resolve the app service principal.');
      err.status = 500; err.code = 'missing_sp_client_id'; throw err;
    }

    const objs = await showAllInShare(req, warehouseId, shareName);
    const catalogs = new Set();
    const schemas = new Set();
    const tables = [];
    for (const o of objs) {
      const fullName = o.shared_object || o.name || '';
      const parts = String(fullName).split('.');
      if (parts.length < 3) continue;
      const [cat, sch, tbl] = parts;
      catalogs.add(cat);
      schemas.add(`${cat}.${sch}`);
      tables.push({ catalog: cat, schema: sch, table: tbl, fullName });
    }

    if (!catalogs.size) {
      res.json({ ok: true, spId, catalogs: [], schemas: [], tables: [], results: [], note: 'Share has no UC objects to grant on.' });
      return;
    }

    const spQ = idQ(spId);
    const grants = [];
    for (const cat of catalogs) {
      grants.push({ scope: 'catalog', target: cat, sql: `GRANT USE CATALOG ON CATALOG ${idQ(cat)} TO ${spQ}` });
    }
    for (const sch of schemas) {
      const [cat, schName] = sch.split('.');
      grants.push({ scope: 'schema', target: sch, sql: `GRANT USE SCHEMA ON SCHEMA ${idQ(cat)}.${idQ(schName)} TO ${spQ}` });
    }
    for (const t of tables) {
      grants.push({
        scope: 'table',
        target: t.fullName,
        sql: `GRANT SELECT ON TABLE ${idQ(t.catalog)}.${idQ(t.schema)}.${idQ(t.table)} TO ${spQ}`,
      });
    }

    const results = [];
    for (const g of grants) {
      try {
        await executeStatement(req, { statement: g.sql, warehouseId });
        results.push({ scope: g.scope, target: g.target, ok: true });
      } catch (e) {
        results.push({ scope: g.scope, target: g.target, ok: false, error: e.message });
      }
    }

    res.json({
      ok: results.every((r) => r.ok),
      spId,
      catalogs: Array.from(catalogs),
      schemas: Array.from(schemas),
      tables: tables.map((t) => t.fullName),
      results,
    });
  } catch (err) { next(err); }
});

export default router;
