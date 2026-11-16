import { Router } from 'express';
import { submitBdcUnpublishJob, revokeSelectOnShare } from '../dbx.js';
import { ensureNotebooks } from '../notebooks.js';
import { requireRequestUser } from '../auth.js';
import { writeActivityEvent, noteWarehouse } from '../activity.js';
import { trackRun, getRunRecord, getPendingRevokes, clearPendingRevoke } from '../runs.js';
import { describeRun } from '../lib/runView.js';
import { invalidate, mapLimit } from '../lib/budget.js';
import { userKey } from '../lib/identity.js';

const router = Router();

async function resolveNotebookPath() {
  const override = process.env.BDC_UNPUBLISH_NOTEBOOK_PATH;
  if (override) return override;
  const { bdc_unpublish: p } = await ensureNotebooks();
  return p;
}

// The Job runs delete_share on the BDC side as the SP. The REVOKE on the
// Databricks side runs only after that succeeded, as the user, so consumers
// keep SELECT if the BDC teardown fails.
router.post('/', async (req, res, next) => {
  try {
    const { shareName, recipientName, warehouseId } = req.body || {};
    if (!shareName || !recipientName) {
      const err = new Error('shareName and recipientName are required'); err.status = 400; throw err;
    }
    if (!warehouseId) {
      const err = new Error('warehouseId is required'); err.status = 400; throw err;
    }
    const user = requireRequestUser(req);
    const userEmail = user.email || user.userName;
    noteWarehouse(warehouseId);
    const notebookPath = await resolveNotebookPath();
    const submitted = await submitBdcUnpublishJob({
      notebookPath,
      parameters: { recipient_name: recipientName, share_name: shareName },
    });
    trackRun({ runId: submitted.run_id, action: 'delete', shareName, recipientName, userEmail, warehouseId });
    void writeActivityEvent({
      eventType: 'delete_submitted', action: 'delete', userEmail,
      shareName, recipientName, runId: submitted.run_id, warehouseId,
    });
    res.json({ ok: true, runId: submitted.run_id, submittedBy: user.userName, notebookPath });
  } catch (err) { next(err); }
});

async function revokeAndLog(req, { shareName, recipientName, runId, warehouseId, userEmail }) {
  try {
    await revokeSelectOnShare(req, warehouseId, shareName, recipientName);
  } catch (e) {
    void writeActivityEvent({
      eventType: 'delete_finalize_failed', action: 'delete', userEmail,
      shareName, recipientName, runId, warehouseId,
      errorCode: e.code || 'revoke_failed', errorMessage: e.message,
    });
    return { ok: false, shareName, recipientName, error: e.message };
  }
  clearPendingRevoke(shareName, recipientName);
  await writeActivityEvent({
    eventType: 'delete_finalized', action: 'delete', userEmail,
    shareName, recipientName, runId, warehouseId,
  });
  return { ok: true, shareName, recipientName };
}

// GET /api/unpublish/pending — the caller's deletes still waiting for REVOKE.
router.get('/pending', async (req, res, next) => {
  try {
    const user = requireRequestUser(req);
    const warehouseId = String(req.query.warehouseId || '') || undefined;
    if (warehouseId) noteWarehouse(warehouseId);
    res.json({ pending: await getPendingRevokes(user.email || user.userName, warehouseId) });
  } catch (err) { next(err); }
});

// POST /api/unpublish/finalize-pending — run every pending REVOKE for the
// caller. The UI calls this on page load, so a delete whose tab was closed
// is completed the next time that user opens the app.
router.post('/finalize-pending', async (req, res, next) => {
  try {
    const user = requireRequestUser(req);
    const userEmail = user.email || user.userName;
    const { warehouseId } = req.body || {};
    if (!warehouseId) { const err = new Error('warehouseId is required'); err.status = 400; throw err; }
    noteWarehouse(warehouseId);
    const pending = await getPendingRevokes(userEmail, warehouseId);
    const results = await mapLimit(pending, 2, (p) => revokeAndLog(req, { ...p, warehouseId, userEmail }));
    if (results.length) { invalidate(`shares:${userKey(req)}:`); invalidate('dashboard:'); }
    res.json({ ok: results.every((r) => r.ok), results });
  } catch (err) { next(err); }
});

// POST /api/unpublish/:runId/finalize — REVOKE for one finished delete.
// Share and connection come from the server-side record of the submit; the
// body is only a fallback for runs submitted before an app restart without
// an activity table.
router.post('/:runId/finalize', async (req, res, next) => {
  try {
    const user = requireRequestUser(req);
    const body = req.body || {};
    const warehouseId = body.warehouseId;
    if (!warehouseId) { const err = new Error('warehouseId is required'); err.status = 400; throw err; }
    const rec = await getRunRecord(req.params.runId);
    const shareName = (rec && rec.shareName) || body.shareName;
    const recipientName = (rec && rec.recipientName) || body.recipientName;
    if (!shareName || !recipientName) {
      const err = new Error('Unknown run; pass shareName and recipientName'); err.status = 400; err.code = 'unknown_run'; throw err;
    }
    const r = await revokeAndLog(req, {
      shareName, recipientName, runId: req.params.runId, warehouseId, userEmail: user.email || user.userName,
    });
    invalidate(`shares:${userKey(req)}:`);
    invalidate('dashboard:');
    if (!r.ok) {
      const err = new Error(`REVOKE SELECT ON SHARE failed: ${r.error}`); err.status = 400; err.code = 'revoke_failed'; throw err;
    }
    res.json({ ok: true, runId: req.params.runId, shareName, recipientName });
  } catch (err) { next(err); }
});

router.get('/:runId', async (req, res, next) => {
  try {
    res.json(await describeRun(req.params.runId));
  } catch (err) { next(err); }
});

export default router;
