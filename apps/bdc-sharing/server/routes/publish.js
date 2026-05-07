import { Router } from 'express';
import {
  submitBdcPublishJob,
  getJobRun,
  getJobRunOutput,
  getAppDeploymentPath,
  grantSelectOnShare,
} from '../dbx.js';
import { requireRequestUser, getRequestUser } from '../auth.js';
import { writeActivityEvent, shouldLogTerminalOnce } from '../activity.js';

const router = Router();

async function resolveNotebookPath() {
  const override = process.env.BDC_NOTEBOOK_PATH;
  if (override) return override;
  const appName = process.env.DATABRICKS_APP_NAME || 'data-sharing';
  const base = await getAppDeploymentPath(appName);
  // DAB layout: app at <bundle-files>/apps/<name>/, notebooks at
  // <bundle-files>/notebooks/. Strip the trailing /apps/<name> segment to
  // reach the bundle files root.
  const dab = base.match(/^(.*)\/apps\/[^/]+$/);
  if (dab) return `${dab[1]}/notebooks/bdc_publish`;
  // Standalone deploy (`databricks apps deploy` against a synced source
  // path that already contains /notebooks/).
  return `${base}/notebooks/bdc_publish`;
}

router.post('/', async (req, res, next) => {
  try {
    const {
      shareName,
      recipientName,
      warehouseId,
      title,
      shortDescription,
      description,
      primaryKeys,
    } = req.body || {};
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

    const user = requireRequestUser(req);

    // Step 0: GRANT runs as the user via OBO. UC enforces ALTER/ownership on
    // the share — if the user can't grant, fail fast with a clear message
    // before we spin up a Job.
    try {
      await grantSelectOnShare(req, warehouseId, shareName, recipientName);
    } catch (e) {
      void writeActivityEvent({
        eventType: 'publish_grant_failed',
        action: 'publish',
        userEmail: user.email || user.userName,
        shareName, recipientName,
        warehouseId,
        errorCode: e.code || 'grant_failed',
        errorMessage: e.message,
      });
      e.status = e.status || 400;
      e.code = 'grant_failed';
      e.message = `GRANT SELECT ON SHARE failed: ${e.message}. ` +
        `You need ALTER (or ownership) on share \`${shareName}\` to grant it ` +
        `to recipient \`${recipientName}\`.`;
      throw e;
    }

    const notebookPath = await resolveNotebookPath();
    const pkJson = primaryKeys && typeof primaryKeys === 'object'
      ? JSON.stringify(primaryKeys)
      : '{}';

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

    void writeActivityEvent({
      eventType: 'publish_submitted',
      action: 'publish',
      userEmail: user.email || user.userName,
      shareName, recipientName,
      runId: submitted.run_id,
      warehouseId,
      metadata: { title: title || shareName, shortDescription: shortDescription || shareName },
    });

    res.json({
      ok: true,
      runId: submitted.run_id,
      submittedBy: user.userName,
      notebookPath,
    });
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

    // On failure, pull the task-level output so we surface the Python error
    // message + short trace back to the UI instead of a generic status.
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
      const eventType = result === 'SUCCESS' ? 'publish_job_succeeded' : 'publish_job_failed';
      if (shouldLogTerminalOnce(req.params.runId, eventType)) {
        void writeActivityEvent({
          eventType,
          action: 'publish',
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
