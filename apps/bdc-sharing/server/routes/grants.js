import { Router } from 'express';
import {
  showGrantsOnShare,
  showGrantsOnRecipient,
  describeShare,
  describeRecipient,
  showAllInShare,
} from '../dbx.js';
import { applySpGrants } from '../lib/spGrants.js';
import { getRequestUser } from '../auth.js';

const router = Router();
function norm(s) { return String(s || '').toLowerCase(); }

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

// Grants the app SP USE CATALOG / USE SCHEMA / SELECT on every source object
// of the share. v2 runs this automatically in pre-flight; the endpoint stays
// for manual re-runs.
router.post('/sp-catalog', async (req, res, next) => {
  try {
    const { shareName, warehouseId } = req.body || {};
    if (!shareName || !warehouseId) {
      const err = new Error('shareName and warehouseId are required');
      err.status = 400; throw err;
    }
    const spId = process.env.DATABRICKS_CLIENT_ID;
    if (!spId) {
      const err = new Error('DATABRICKS_CLIENT_ID is not set, cannot resolve the app service principal.');
      err.status = 500; err.code = 'missing_sp_client_id'; throw err;
    }
    const objs = await showAllInShare(req, warehouseId, shareName);
    const fullNames = objs.map((o) => o.shared_object || o.name || '').filter((n) => String(n).split('.').length === 3);
    if (!fullNames.length) {
      res.json({ ok: true, spId, results: [], note: 'Share has no UC objects to grant on.' });
      return;
    }
    const applied = await applySpGrants(req, warehouseId, spId, fullNames);
    res.json({
      ok: applied.ok,
      spId,
      tables: fullNames,
      results: applied.results.map((r) => ({ scope: r.scope, target: r.target, ok: r.ok, error: r.error, sql: r.sql })),
    });
  } catch (err) { next(err); }
});

export default router;
