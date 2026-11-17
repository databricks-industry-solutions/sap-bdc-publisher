import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

import meRouter from './routes/me.js';
import sharesRouter from './routes/shares.js';
import recipientsRouter from './routes/recipients.js';
import grantsRouter from './routes/grants.js';
import publishRouter from './routes/publish.js';
import unpublishRouter from './routes/unpublish.js';
import diagRouter from './routes/diag.js';
import warehousesRouter from './routes/warehouses.js';
import activityRouter from './routes/activity.js';
import setupRouter from './routes/setup.js';
import preflightRouter from './routes/preflight.js';
import dashboardRouter from './routes/dashboard.js';
import { startReconciler, reconcileOnce } from './runs.js';
import { noteWarehouse } from './activity.js';
import { getSpToken } from './spAuth.js';
import { getActivityConfig } from './config.js';
import { getWarehouseSp } from './dbx.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8000;

app.use(express.json({ limit: '1mb' }));

// Remember a warehouse the app can use for background work (run
// reconciler). Any request that names one is enough.
app.use((req, _res, next) => {
  const id = (req.query && req.query.warehouseId) || (req.body && req.body.warehouseId);
  if (id) noteWarehouse(String(id));
  next();
});

// Health. Plain call is a liveness probe. ?deep=true also checks the SP
// token, the warehouse (if passed) and the activity log config, so the FAQ
// troubleshooting block can point at the broken piece.
app.get('/api/health', async (req, res) => {
  if (String(req.query.deep || '') !== 'true') {
    return res.json({ status: 'healthy', app: 'data-sharing' });
  }
  const checks = [];
  try { await getSpToken(); checks.push({ check: 'App SP token', ok: true }); }
  catch (e) { checks.push({ check: 'App SP token', ok: false, message: e.message }); }
  const wh = String(req.query.warehouseId || '');
  if (wh) {
    try {
      const w = await getWarehouseSp(wh);
      checks.push({ check: 'App SP can see the warehouse', ok: true, state: w.state });
    } catch (e) { checks.push({ check: 'App SP can see the warehouse', ok: false, message: e.message }); }
  }
  try {
    const cfg = await getActivityConfig();
    checks.push({ check: 'Activity log configured', ok: !!cfg.table, table: cfg.table, source: cfg.source });
  } catch (e) { checks.push({ check: 'Activity log configured', ok: false, message: e.message }); }
  try {
    const r = await reconcileOnce();
    checks.push({ check: 'Run reconciler', ok: true, ...r });
  } catch (e) { checks.push({ check: 'Run reconciler', ok: false, message: e.message }); }
  res.json({ status: checks.every((c) => c.ok) ? 'healthy' : 'degraded', checks });
});

// User-scoped API (OBO)
app.use('/api/me', meRouter);
app.use('/api/shares', sharesRouter);
app.use('/api/recipients', recipientsRouter);
app.use('/api/grants', grantsRouter);
app.use('/api/publish', publishRouter);
app.use('/api/unpublish', unpublishRouter);
app.use('/api/diag', diagRouter);
app.use('/api/warehouses', warehousesRouter);
app.use('/api/activity', activityRouter);
app.use('/api/setup', setupRouter);
app.use('/api/preflight', preflightRouter);
app.use('/api/dashboard', dashboardRouter);

// Serve README.md from project root (rendered by public/docs.html).
app.get('/README.md', (_req, res) => {
  res.type('text/markdown').sendFile(path.join(__dirname, '..', 'README.md'));
});

// Serve static frontend
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use((err, _req, res, _next) => {
  // eslint-disable-next-line no-console
  console.error('[error]', err);
  const status = err.status || 500;
  res.status(status).json({
    error: err.code || 'internal_error',
    message: err.message || 'Unexpected server error',
    details: err.details,
  });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Data Sharing app listening on :${PORT}`);
  startReconciler();
});
