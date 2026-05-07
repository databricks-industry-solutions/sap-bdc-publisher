import { Router } from 'express';
import { listRecipientsRaw, describeRecipient } from '../dbx.js';
import { getRequestUser } from '../auth.js';

const router = Router();
function norm(s) { return String(s || '').toLowerCase(); }

const BDC_NAME_RE = /^bdc-connect-/i;

router.get('/', async (req, res, next) => {
  try {
    const warehouseId = String(req.query.warehouseId || '');
    if (!warehouseId) { const e = new Error('warehouseId query param is required'); e.status = 400; throw e; }
    const user = getRequestUser(req);
    const userEmail = norm(user.userName || user.email);

    const all = await listRecipientsRaw(req, warehouseId);
    const bdc = all.filter((r) => BDC_NAME_RE.test(r.name || ''));
    if (!bdc.length) {
      return res.json({
        recipients: [],
        counts: { total: all.length, bdc: 0 },
        note: all.length ? 'No BDC Connect recipients (bdc-connect-*) visible.' : 'No recipients visible.',
      });
    }

    const enriched = await Promise.all(bdc.map(async (r) => {
      let owner = r.created_by;
      try {
        const desc = await describeRecipient(req, warehouseId, r.name);
        const d0 = desc[0] || {};
        if (d0.owner) owner = d0.owner;
      } catch { /* ignore */ }
      return {
        name: r.name, owner, createdBy: r.created_by, createdAt: r.created_at,
        comment: r.comment, authenticationType: r.authentication_type,
        isOwner: owner && norm(owner) === userEmail,
        userGrants: [], looksLikeBdc: true,
      };
    }));

    res.json({ recipients: enriched, counts: { total: all.length, bdc: enriched.length } });
  } catch (err) { next(err); }
});

export default router;
