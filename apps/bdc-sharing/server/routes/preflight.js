import { Router } from 'express';
import crypto from 'node:crypto';
import { runPreflight } from '../lib/preflight.js';
import { budgeted } from '../lib/budget.js';
import { userKey } from '../lib/identity.js';
import { noteWarehouse } from '../activity.js';

const router = Router();

// POST /api/preflight
// Body: { shareName, recipientName, warehouseId, primaryKeys, applyGrants }
// Runs the checks (and the SP grants, as the caller) under the request
// budget. The browser re-sends the same body on 202 and attaches to the run
// already in flight.
router.post('/', (req, res, next) => {
  const b = req.body || {};
  if (!b.shareName || !b.recipientName || !b.warehouseId) {
    const e = new Error('shareName, recipientName and warehouseId are required'); e.status = 400; return next(e);
  }
  noteWarehouse(b.warehouseId);
  const hash = crypto.createHash('sha1').update(JSON.stringify([b.shareName, b.recipientName, b.warehouseId, b.primaryKeys || {}, b.applyGrants !== false])).digest('hex');
  budgeted(req, res, next, `preflight:${userKey(req)}:${hash}`,
    () => runPreflight(req, {
      shareName: b.shareName,
      recipientName: b.recipientName,
      warehouseId: b.warehouseId,
      primaryKeys: b.primaryKeys || {},
      applyGrants: b.applyGrants !== false,
    }),
    { ttlMs: 10_000, refresh: !!b.refresh });
});

export default router;
