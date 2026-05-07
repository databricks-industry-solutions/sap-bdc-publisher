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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8000;

app.use(express.json({ limit: '1mb' }));

// Health (no auth needed)
app.get('/api/health', (_req, res) => {
  res.json({ status: 'healthy', app: 'data-sharing' });
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
});
