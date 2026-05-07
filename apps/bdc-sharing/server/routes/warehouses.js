import { Router } from 'express';
import { listWarehouses, getWarehouse, kickWarehouseStart, rankWarehouses } from '../dbx.js';

const router = Router();

// GET /api/warehouses — SP list (matches what the SP can start on your behalf).
router.get('/', async (_req, res, next) => {
  try {
    const whs = await listWarehouses();
    const ranked = rankWarehouses(whs);
    res.json({
      warehouses: ranked.map((w) => ({
        id: w.id, name: w.name, size: w.cluster_size, state: w.state,
        serverless: !!w.enable_serverless_compute,
      })),
      defaultId: ranked[0]?.id || null,
    });
  } catch (err) { next(err); }
});

// GET /api/warehouses/:id — current state (used for polling during startup).
router.get('/:id', async (req, res, next) => {
  try {
    const w = await getWarehouse(req.params.id);
    res.json({
      id: w.id, name: w.name, size: w.cluster_size, state: w.state,
      serverless: !!w.enable_serverless_compute,
    });
  } catch (err) { next(err); }
});

// POST /api/warehouses/:id/start — kick off start if stopped, return immediately.
// The client then polls GET /:id until state === RUNNING.
router.post('/:id/start', async (req, res, next) => {
  try {
    const { warehouse, started } = await kickWarehouseStart(req.params.id);
    res.json({
      id: warehouse.id, name: warehouse.name, size: warehouse.cluster_size,
      state: warehouse.state, serverless: !!warehouse.enable_serverless_compute,
      started,
    });
  } catch (err) { next(err); }
});

export default router;
