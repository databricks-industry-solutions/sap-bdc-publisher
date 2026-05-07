import { Router } from 'express';
import {
  submitBdcUnpublishJob,
  getJobRun,
  getJobRunOutput,
  getAppDeploymentPath,
  revokeSelectOnShare,
} from '../dbx.js';
import { requireRequestUser, getRequestUser } from '../auth.js';
import { writeActivityEvent, shouldLogTerminalOnce } from '../activity.js';

const router = Router();

async function resolveNotebookPath() {
  const override = process.env.BDC_UNPUBLISH_NOTEBOOK_PATH;
  if (override) return override;
  const appName = process.env.DATABRICKS_APP_NAME || 'data-sharing';
  const base = await getAppDeploymentPath(appName);
  const dab = base.match(/^(.*)\/apps\/[^/]+$/);
  if (dab) return `${dab[1]}/notebooks/bdc_unpublish`;
  return `${base}/notebooks/bdc_unpublish`;
}

router.post('/', async (req, res, next) => {
  try {
    const { shareName, recipientName, warehouseId } = req.body || {};
    if (!shareName || !recipientName) {
      const err = new Error('shareName and recipientName are required');
      err.status = 400;
      throw err;
    }
    if (!warehouseId) {
      const err = new Error('warehouseId is required');
      err.status = 400;
      throw err;
    }

    const notebookPath = await resolveNotebookPath();
    const user = requireRequestUser(req);

    // The Job runs delete_share on the BDC side as the SP. The REVOKE on the
    // Databricks side is intentionally deferred to /finalize, which runs as
    // the user via OBO once the BDC delete has succeeded — so consumers
    // don't lose SELECT mid-read if the BDC teardown fails.
    const submitted = await submitBdcUnpublishJob({
      notebookPath,
      parameters: {
        recipient_name: recipientName,
        share_name: shareName,
      },
    });

    void writeActivityEvent({
      eventType: 'delete_submitted',
      action: 'delete',
      userEmail: user.email || user.userName,
      shareName, recipientName,
      runId: submitted.run_id,
      warehouseId,
    });

    res.json({
      ok: true,
      runId: submitted.run_id,
      submittedBy: user.userName,
      notebookPath,
    });
  } catch (err) { next(err); }
});

// Called by the UI after the unpublish Job lands SUCCESS. Runs REVOKE SELECT
// ON SHARE as the user via OBO, completing the teardown on the Databricks
// side. Idempotent — REVOKE on a grant that no longer exists is a no-op.
router.post('/:runId/finalize', async (req, res, next) => {
  try {
    const { shareName, recipientName, warehouseId } = req.body || {};
    if (!shareName || !recipientName || !warehouseId) {
      const err = new Error('shareName, recipientName, and warehouseId are required');
      err.status = 400;
      throw err;
    }
    const user = requireRequestUser(req);
    try {
      await revokeSelectOnShare(req, warehouseId, shareName, recipientName);
    } catch (e) {
      void writeActivityEvent({
        eventType: 'delete_finalize_failed',
        action: 'delete',
        userEmail: user.email || user.userName,
        shareName, recipientName,
        runId: req.params.runId,
        warehouseId,
        errorCode: e.code || 'revoke_failed',
        errorMessage: e.message,
      });
      e.status = e.status || 400;
      e.code = 'revoke_failed';
      e.message = `REVOKE SELECT ON SHARE failed: ${e.message}`;
      throw e;
    }
    void writeActivityEvent({
      eventType: 'delete_finalized',
      action: 'delete',
      userEmail: user.email || user.userName,
      shareName, recipientName,
      runId: req.params.runId,
      warehouseId,
    });
    res.json({ ok: true, runId: req.params.runId });
  } catch (err) { next(err); }
});

router.get('/:runId', async (req, res, next) => {
  try {
    const run = await getJobRun(req.params.runId);
    const life = run.state?.life_cycle_state || run.status?.state || 'UNKNOWN';
    const result = run.state?.result_state || '';
    const terminal = life === 'TERMINATED' || life === 'INTERNAL_ERROR' || life === 'SKIPPED';
    const failed = terminal && result !== 'SUCCESS';
    const warehouseId = String(req.query.warehouseId || '');
    const user = getRequestUser(req);

    const out = {
      runId: run.run_id,
      state: run.state,
      status: run.status,
      runPageUrl: run.run_page_url,
      startTime: run.start_time,
      endTime: run.end_time,
      stateMessage: run.state?.state_message || null,
      tasks: (run.tasks || []).map((t) => ({
        taskKey: t.task_key,
        runId: t.run_id,
        state: t.state,
        runPageUrl: t.run_page_url,
      })),
    };

    if (failed) {
      const taskRunId = (run.tasks && run.tasks[0] && run.tasks[0].run_id) || run.run_id;
      try {
        const o = await getJobRunOutput(taskRunId);
        out.error = {
          message: o.error || run.state?.state_message || null,
          trace: o.error_trace || null,
          notebookExit: o.notebook_output?.result || null,
          logs: o.logs || null,
          logsTruncated: !!o.logs_truncated,
          taskRunId,
        };
      } catch (e) {
        out.error = {
          message: run.state?.state_message || 'Job failed (could not fetch task output)',
          detail: e.message,
          taskRunId,
        };
      }
    }

    if (terminal) {
      const eventType = result === 'SUCCESS' ? 'delete_job_succeeded' : 'delete_job_failed';
      if (shouldLogTerminalOnce(req.params.runId, eventType)) {
        void writeActivityEvent({
          eventType,
          action: 'delete',
          userEmail: user.email || user.userName,
          shareName: req.query.shareName || '',
          recipientName: req.query.recipientName || '',
          runId: req.params.runId,
          warehouseId,
          errorCode: failed ? (run.state?.state_message ? 'job_failed' : 'unknown') : null,
          errorMessage: failed ? (out.error?.message || run.state?.state_message || null) : null,
        });
      }
    }

    res.json(out);
  } catch (err) { next(err); }
});

export default router;
