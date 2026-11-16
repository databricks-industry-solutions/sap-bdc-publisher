import { Router } from 'express';
import { listActivityEvents } from '../activity.js';
import { getUserGroupsByEmail } from '../dbx.js';
import { requireRequestUser, getWorkspaceHost } from '../auth.js';
import { getActivityConfig, getActivityTable } from '../config.js';
import { spSqlQuery } from '../dbx.js';
import { budgeted } from '../lib/budget.js';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const { table, source } = await getActivityConfig();
    const enabled = !!table;
    if (!enabled) {
      res.json({ enabled: false, source: null, events: [], isAdmin: false, viewingAll: false });
      return;
    }
    const user = requireRequestUser(req);
    const warehouseId = String(req.query.warehouseId || '');
    if (!warehouseId) {
      const err = new Error('warehouseId is required');
      err.status = 400;
      throw err;
    }
    const wantsAll = String(req.query.all || '') === 'true';
    const limit = Number(req.query.limit) || 100;

    const adminGroup = process.env.BDC_ACTIVITY_ADMIN_GROUP;
    let isAdmin = false;
    if (adminGroup) {
      const groups = await getUserGroupsByEmail(req, user.email).catch(() => []);
      isAdmin = groups.includes(adminGroup);
    }

    const useAll = wantsAll && isAdmin;
    const events = await listActivityEvents(req, {
      warehouseId,
      userEmail: user.email || user.userName,
      all: useAll,
      limit,
    });

    res.json({
      enabled: true,
      source,
      table,
      isAdmin,
      viewingAll: useAll,
      workspaceHost: getWorkspaceHost(),
      events,
    });
  } catch (err) { next(err); }
});

// GET /api/activity/last-published?warehouseId=…
// Date of the last successful publish per share, for the Publish page. Read
// by the SP and limited to dates (no user names), so it works without the
// optional `account users` grant on the activity table.
router.get('/last-published', (req, res, next) => {
  const warehouseId = String(req.query.warehouseId || '');
  if (!warehouseId) { const e = new Error('warehouseId is required'); e.status = 400; return next(e); }
  budgeted(req, res, next, `lastpub:${warehouseId}`, async () => {
    const table = await getActivityTable();
    if (!table) return { enabled: false, shares: [] };
    const rows = await spSqlQuery(warehouseId,
      `SELECT share_name, CAST(max(event_time) AS STRING) AS at FROM ${table} ` +
      `WHERE event_type IN ('publish_job_succeeded', 'republish_job_succeeded') GROUP BY share_name`);
    return { enabled: true, shares: rows.map((r) => ({ shareName: r.share_name, at: r.at })) };
  }, { ttlMs: 60_000 });
});

export default router;
