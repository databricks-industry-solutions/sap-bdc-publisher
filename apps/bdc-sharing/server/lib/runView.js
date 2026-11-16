// Shared shape for GET /api/publish/:runId and GET /api/unpublish/:runId.

import { getJobRun, getJobRunOutput } from '../dbx.js';
import { getRunRecord, observeRun, isTerminal } from '../runs.js';

export async function describeRun(runId) {
  const run = await getJobRun(runId);
  const terminal = isTerminal(run);
  const failed = terminal && run.state?.result_state !== 'SUCCESS';
  const out = {
    runId: run.run_id,
    state: run.state,
    status: run.status,
    runPageUrl: run.run_page_url,
    startTime: run.start_time,
    endTime: run.end_time,
    stateMessage: run.state?.state_message || null,
    tasks: (run.tasks || []).map((t) => ({ taskKey: t.task_key, runId: t.run_id, state: t.state, runPageUrl: t.run_page_url })),
  };
  // On failure, pull the task output so the UI shows the Python error
  // instead of a generic status.
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
      out.error = { message: run.state?.state_message || 'Job failed (could not fetch task output)', detail: e.message, taskRunId };
    }
  }
  if (terminal) {
    // Share and connection come from the server-side record of the submit,
    // not from the caller.
    const rec = await getRunRecord(runId);
    if (rec) {
      out.shareName = rec.shareName;
      out.recipientName = rec.recipientName;
      out.action = rec.action;
      // Awaited so a following /finalize can't land before the terminal
      // event it depends on.
      await observeRun(rec, run, out.error && out.error.message).catch(() => {});
    }
  }
  return out;
}
