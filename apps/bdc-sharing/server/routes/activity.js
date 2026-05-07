import { Router } from 'express';
import { listActivityEvents } from '../activity.js';
import { getUserGroupsByEmail } from '../dbx.js';
import { requireRequestUser, getWorkspaceHost } from '../auth.js';
import { getActivityConfig } from '../config.js';

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

export default router;
