import { Router } from 'express';
import {
  listSharesWithGrants,
  listRecipientsInfo,
  listSharesRaw,
  listRecipientsRaw,
  describeShare,
  showAllInShare,
  showGrantsOnShare,
  getTablesColumnsAndPk,
} from '../dbx.js';
import { isBdcRecipient, needsSecretScope } from '../bdc.js';
import { budgeted, mapLimit } from '../lib/budget.js';
import { getIdentity, ownsPrincipal, userKey } from '../lib/identity.js';

const router = Router();

function requireWarehouse(req) {
  const warehouseId = String(req.query.warehouseId || '');
  if (!warehouseId) { const e = new Error('warehouseId query param is required'); e.status = 400; throw e; }
  return warehouseId;
}

// v2 path: one statement for all shares and their recipient grants.
async function sharesFromInformationSchema(req, warehouseId) {
  const rows = await listSharesWithGrants(req, warehouseId);
  const byName = new Map();
  for (const r of rows) {
    if (!byName.has(r.share_name)) {
      byName.set(r.share_name, {
        name: r.share_name,
        owner: r.share_owner,
        comment: r.comment,
        createdAt: r.created,
        createdBy: r.created_by,
        lastAltered: r.last_altered,
        tableCount: r.table_count == null ? 0 : Number(r.table_count),
        bdcConnections: [],
        otherRecipientCount: 0,
      });
    }
    const s = byName.get(r.share_name);
    if (!r.recipient_name) continue;
    if (String(r.privilege_type || '').toUpperCase() !== 'SELECT') continue;
    if (isBdcRecipient(r.recipient_name)) {
      s.bdcConnections.push({ name: r.recipient_name, authenticationType: r.authentication_type || null });
    } else {
      s.otherRecipientCount += 1;
    }
  }
  return Array.from(byName.values());
}

// v1-style fallback, used only if information_schema is not readable on this
// warehouse. Still one statement per share, but capped at 4 in flight.
async function sharesFromShowCommands(req, warehouseId) {
  const shares = await listSharesRaw(req, warehouseId);
  return mapLimit(shares, 4, async (s) => {
    const [grants, desc] = await Promise.all([
      showGrantsOnShare(req, warehouseId, s.name).catch(() => []),
      describeShare(req, warehouseId, s.name),
    ]);
    const bdcConnections = [];
    let otherRecipientCount = 0;
    for (const g of grants) {
      const principal = g.recipient || g.principal;
      const priv = String(g.privilege || g.action_type || '').toUpperCase();
      if (!principal || priv !== 'SELECT') continue;
      if (isBdcRecipient(principal)) bdcConnections.push({ name: principal, authenticationType: null });
      else otherRecipientCount += 1;
    }
    return {
      name: s.name,
      owner: (desc[0] && desc[0].owner) || s.created_by,
      comment: s.comment,
      createdAt: s.created_at,
      createdBy: s.created_by,
      lastAltered: null,
      tableCount: null,
      bdcConnections,
      otherRecipientCount,
    };
  });
}

async function connectionsList(req, warehouseId) {
  try {
    const rows = await listRecipientsInfo(req, warehouseId);
    return {
      total: rows.length,
      connections: rows.filter((r) => isBdcRecipient(r.recipient_name)).map((r) => ({
        name: r.recipient_name,
        id: r.recipient_id,
        owner: r.recipient_owner,
        authenticationType: r.authentication_type,
        comment: r.comment,
        needsSecretScope: needsSecretScope(r.authentication_type),
      })),
    };
  } catch {
    const rows = await listRecipientsRaw(req, warehouseId);
    return {
      total: rows.length,
      connections: rows.filter((r) => isBdcRecipient(r.name)).map((r) => ({
        name: r.name,
        id: null,
        owner: r.created_by,
        authenticationType: r.authentication_type,
        comment: r.comment,
        needsSecretScope: needsSecretScope(r.authentication_type),
      })),
    };
  }
}

export async function loadOverview(req, warehouseId) {
  const identity = await getIdentity(req);
  let source = 'information_schema';
  const [shares, conns] = await Promise.all([
    sharesFromInformationSchema(req, warehouseId).catch((e) => {
      console.error('[shares] information_schema path failed, falling back to SHOW', e.message);
      source = 'show_commands';
      return sharesFromShowCommands(req, warehouseId);
    }),
    connectionsList(req, warehouseId),
  ]);
  const enriched = shares.map((s) => ({
    ...s,
    isOwner: ownsPrincipal(identity, s.owner),
    // v1 field names, kept for the diag page and older clients.
    publishedRecipients: s.bdcConnections.map((c) => c.name),
    publishedToBdc: s.bdcConnections.length > 0,
  }));
  return {
    source,
    shares: enriched,
    connections: conns.connections,
    recipients: conns.connections, // v1 name used by /api/recipients callers
    counts: {
      total: enriched.length,
      owned: enriched.filter((s) => s.isOwner).length,
      inBdc: enriched.filter((s) => s.publishedToBdc).length,
      recipients: conns.total,
      connections: conns.connections.length,
    },
  };
}

// GET /api/shares?warehouseId=…[&refresh=1]
// Shares visible to the caller plus their BDC connections, in 2 statements.
router.get('/', (req, res, next) => {
  let warehouseId;
  try { warehouseId = requireWarehouse(req); } catch (e) { return next(e); }
  budgeted(req, res, next, `shares:${userKey(req)}:${warehouseId}`,
    () => loadOverview(req, warehouseId),
    { ttlMs: 30_000, refresh: !!req.query.refresh });
});

export async function loadShareDetail(req, warehouseId, name) {
  const identity = await getIdentity(req);
  const [descRows, objRows] = await Promise.all([
    describeShare(req, warehouseId, name),
    showAllInShare(req, warehouseId, name),
  ]);
  const d0 = descRows[0] || {};
  const owner = d0.owner || d0.created_by || null;
  const objects = objRows.map((r) => ({
    name: r.name || r.shared_object || '',
    dataObjectType: String(r.type || '').toUpperCase(),
    sharedAs: r.name || null,
    fullName: r.shared_object || r.name || null,
    addedAt: r.added_at || null,
    addedBy: r.added_by || null,
    comment: r.comment || null,
  })).filter((o) => o.name || o.dataObjectType);

  const tableObjs = objects.filter((o) => o.dataObjectType === 'TABLE');
  let meta = new Map();
  try {
    meta = await getTablesColumnsAndPk(req, warehouseId, tableObjs.map((o) => o.fullName));
  } catch (e) {
    console.error('[shares] column/PK lookup failed', e.message);
  }
  const tables = tableObjs.map((o) => {
    const m = meta.get(String(o.fullName).toLowerCase()) || { columns: [], primaryKey: [] };
    return {
      sharedAs: o.sharedAs || o.fullName,
      fullName: o.fullName,
      columns: m.columns,
      primaryKey: m.primaryKey,
      hasPrimaryKey: m.primaryKey.length > 0,
    };
  });
  return {
    name, owner, comment: d0.comment || null,
    isOwner: ownsPrincipal(identity, owner),
    userGrants: [],
    objects, tables, count: tables.length,
  };
}

// GET /api/shares/:name?warehouseId=…
// Objects, columns and UC primary keys for one share. Three statements in
// total, regardless of how many tables the share holds.
router.get('/:name', (req, res, next) => {
  let warehouseId;
  try { warehouseId = requireWarehouse(req); } catch (e) { return next(e); }
  const name = req.params.name;
  budgeted(req, res, next, `share:${userKey(req)}:${warehouseId}:${name}`,
    () => loadShareDetail(req, warehouseId, name),
    { ttlMs: 30_000, refresh: !!req.query.refresh });
});

// Kept for older clients. Same payload as GET /:name.
router.get('/:name/tables', (req, res, next) => {
  let warehouseId;
  try { warehouseId = requireWarehouse(req); } catch (e) { return next(e); }
  const name = req.params.name;
  budgeted(req, res, next, `share:${userKey(req)}:${warehouseId}:${name}`,
    () => loadShareDetail(req, warehouseId, name),
    { ttlMs: 30_000, refresh: !!req.query.refresh });
});

export default router;
