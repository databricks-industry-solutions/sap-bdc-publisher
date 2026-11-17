import { Router } from 'express';
import { loadOverview } from './shares.js';
import { budgeted } from '../lib/budget.js';
import { userKey } from '../lib/identity.js';

const router = Router();

// GET /api/recipients?warehouseId=… — BDC connections visible to the caller.
// Shares the cached overview with /api/shares so both cost one round trip.
router.get('/', (req, res, next) => {
  const warehouseId = String(req.query.warehouseId || '');
  if (!warehouseId) { const e = new Error('warehouseId query param is required'); e.status = 400; return next(e); }
  budgeted(req, res, next, `shares:${userKey(req)}:${warehouseId}`,
    () => loadOverview(req, warehouseId),
    { ttlMs: 30_000, refresh: !!req.query.refresh });
});

export default router;
