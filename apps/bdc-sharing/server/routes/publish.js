import { Router } from 'express';
import { submitBdcPublishJob, grantSelectOnShare, getShareSourceSummary } from '../dbx.js';
import { ensureNotebooks } from '../notebooks.js';
import { requireRequestUser } from '../auth.js';
import { writeActivityEvent, noteWarehouse } from '../activity.js';
import { trackRun, clearPendingRevoke } from '../runs.js';
import { describeRun } from '../lib/runView.js';
import { invalidate } from '../lib/budget.js';
import { userKey } from '../lib/identity.js';
import { assertReady } from '../lib/readiness.js';

const router = Router();

async function resolveNotebookPath() {
  const override = process.env.BDC_NOTEBOOK_PATH;
  if (override) return override;
  const { bdc_publish: p } = await ensureNotebooks();
  return p;
}

// POST /api/publish
// Body: { shareName, recipientName, warehouseId, title, shortDescription,
//         description, primaryKeys, republish }
// republish=true is "Update in BDC": the grant already exists, so only the
// job runs (ORD + CSN upsert + publish).
router.post('/', async (req, res, next) => {
  try {
    const {
      shareName, recipientName, warehouseId,
      title, shortDescription, description, primaryKeys, republish,
    } = req.body || {};
    if (!shareName || !recipientName) {
      const err = new Error('shareName and recipientName are required'); err.status = 400; throw err;
    }
    if (!warehouseId) {
      const err = new Error('warehouseId is required'); err.status = 400; throw err;
    }
    const user = requireRequestUser(req);
    const userEmail = user.email || user.userName;
    const action = republish ? 'republish' : 'publish';
    noteWarehouse(warehouseId);
    // Nothing runs until the activity log works, so every action is recorded.
    await assertReady(warehouseId);

    // The GRANT runs as the user via OBO. If they can't grant, fail before
    // a job starts.
    if (!republish) {
      try {
        await grantSelectOnShare(req, warehouseId, shareName, recipientName);
      } catch (e) {
        void writeActivityEvent({
          eventType: 'publish_grant_failed', action: 'publish', userEmail,
          shareName, recipientName, warehouseId,
          errorCode: e.code || 'grant_failed', errorMessage: e.message,
        });
        e.status = e.status || 400;
        e.code = 'grant_failed';
        e.message = `GRANT SELECT ON SHARE failed: ${e.message}. ` +
          `To grant share \`${shareName}\` to \`${recipientName}\` you need to own the share and have USE RECIPIENT, ` +
          `or have USE RECIPIENT, USE SHARE and SET SHARE PERMISSION.`;
        throw e;
      }
    }

    const notebookPath = await resolveNotebookPath();
    const pkJson = primaryKeys && typeof primaryKeys === 'object' ? JSON.stringify(primaryKeys) : '{}';
    const submitted = await submitBdcPublishJob({
      notebookPath,
      parameters: {
        recipient_name: recipientName,
        share_name: shareName,
        title: title || shareName,
        short_description: shortDescription || shareName,
        description: description || `Published from Data Sharing app: ${shareName}`,
        primary_keys_json: pkJson,
      },
    });

    trackRun({ runId: submitted.run_id, action, shareName, recipientName, userEmail, warehouseId });
    clearPendingRevoke(shareName, recipientName);
    invalidate(`shares:${userKey(req)}:`);
    invalidate('dashboard:');

    // Log the submit after answering, with the share's table count and the
    // latest source change for drift tracking. Best effort.
    res.json({ ok: true, runId: submitted.run_id, submittedBy: user.userName, notebookPath, action });
    let summary = null;
    try { summary = (await getShareSourceSummary(req, warehouseId, [shareName]))[0] || null; } catch { /* optional */ }
    void writeActivityEvent({
      eventType: `${action}_submitted`, action: 'publish', userEmail,
      shareName, recipientName, runId: submitted.run_id, warehouseId,
      shareObjectCount: summary ? summary.table_count : null,
      sourceLastAltered: summary ? summary.source_last_altered : null,
      metadata: { title: title || shareName, shortDescription: shortDescription || shareName, primaryKeys: primaryKeys || {} },
    });
  } catch (err) { next(err); }
});

router.get('/:runId', async (req, res, next) => {
  try {
    res.json(await describeRun(req.params.runId));
  } catch (err) { next(err); }
});

export default router;
