// Pre-flight checks before a publish. Each check returns ok | warn | fail.
// Only "fail" blocks the publish. "warn" means the app could not prove the
// condition and Unity Catalog or the job will have the final word.

import { loadShareDetail, loadOverview } from '../routes/shares.js';
import { spCanReadTables, spCheckSecretScope } from '../dbx.js';
import { applySpGrants, spGrantStatements } from './spGrants.js';
import { SDK_SECRET_SCOPE, needsSecretScope, viewsAllowed, VIEW_TYPES } from '../bdc.js';
import { writeActivityEvent } from '../activity.js';
import { getRequestUser } from '../auth.js';

const GRANT_REQUIREMENT =
  'Granting a share to a recipient needs share ownership plus USE RECIPIENT, ' +
  'or USE RECIPIENT + USE SHARE + SET SHARE PERMISSION.';

export async function runPreflight(req, { shareName, recipientName, warehouseId, primaryKeys = {}, applyGrants = true, refresh = false }) {
  const spId = process.env.DATABRICKS_CLIENT_ID || null;
  const user = getRequestUser(req);
  const [detail, overview] = await Promise.all([
    loadShareDetail(req, warehouseId, shareName, { refresh }),
    loadOverview(req, warehouseId),
  ]);
  const share = overview.shares.find((s) => s.name === shareName) || null;
  const conn = overview.connections.find((c) => c.name === recipientName) || null;
  const checks = [];

  // (a) Object types
  const allowViews = viewsAllowed();
  const unsupported = detail.objects.filter((o) => {
    if (o.dataObjectType === 'TABLE') return false;
    if (VIEW_TYPES.has(o.dataObjectType)) return !allowViews;
    return true;
  });
  if (!detail.objects.length) {
    checks.push({ id: 'objects', label: 'Share has objects', status: 'fail', detail: 'The share is empty. Add tables to it first.' });
  } else if (unsupported.length) {
    checks.push({
      id: 'objects', label: 'Object types supported', status: 'fail',
      detail: `${unsupported.length} object(s) can't be published to BDC by this app: ` +
        unsupported.map((o) => `${o.name} (${o.dataObjectType})`).join(', ') +
        (allowViews ? '.' : '. Views are blocked until BDC Connect support is confirmed for your landscape. ' +
          'An admin can set BDC_ALLOW_VIEWS=true in app.yaml once it is (see FAQ).'),
      objects: unsupported.map((o) => o.name),
    });
  } else {
    checks.push({ id: 'objects', label: 'Object types supported', status: 'ok', detail: `${detail.objects.length} object(s), all supported.` });
  }

  // (b) Primary keys
  const unknown = detail.tables.filter((t) => !t.columnsKnown);
  const missingPk = detail.tables.filter((t) => t.columnsKnown && !t.hasPrimaryKey && !(primaryKeys[t.sharedAs] || []).length);
  if (detail.columnsError || unknown.length) {
    checks.push({
      id: 'pk', label: 'Primary keys', status: 'warn',
      detail: detail.columnsError
        ? `Couldn't read columns and keys from Unity Catalog (${detail.columnsError}). Re-check to try again.`
        : `Columns aren't visible to you for ${unknown.length} table(s): ${unknown.map((t) => t.sharedAs).join(', ')}. Their keys can't be checked here.`,
      tables: unknown.map((t) => t.sharedAs),
    });
  } else if (missingPk.length) {
    checks.push({
      id: 'pk', label: 'Primary keys', status: 'warn',
      detail: `${missingPk.length} table(s) have no primary key in Unity Catalog and none was picked: ` +
        missingPk.map((t) => t.sharedAs).join(', ') + '. BDC expects a key per entity. Pick key columns below or publish without.',
      tables: missingPk.map((t) => t.sharedAs),
    });
  } else {
    checks.push({ id: 'pk', label: 'Primary keys', status: 'ok', detail: 'Every table has a key from Unity Catalog or from your selection.' });
  }

  // (c) Can the user grant?
  if (share && share.isOwner) {
    checks.push({ id: 'grant', label: 'You can grant this share', status: 'ok', detail: 'You (or a group you belong to) own the share.' });
  } else {
    checks.push({
      id: 'grant', label: 'You can grant this share', status: 'warn',
      detail: `You don't own the share${share && share.owner ? ` (owner: ${share.owner})` : ''}. ${GRANT_REQUIREMENT} Unity Catalog checks this when you publish.`,
    });
  }

  // (d) SP access to source tables
  const fullNames = detail.tables.map((t) => t.fullName).filter(Boolean);
  if (!spId) {
    checks.push({ id: 'sp', label: 'App can read source tables', status: 'warn', detail: 'DATABRICKS_CLIENT_ID is not set, so the app SP could not be checked.' });
  } else if (!fullNames.length) {
    checks.push({ id: 'sp', label: 'App can read source tables', status: 'ok', detail: 'No tables to check.' });
  } else {
    let probe = await spCanReadTables(warehouseId, fullNames);
    if (probe.ok) {
      checks.push({ id: 'sp', label: 'App can read source tables', status: 'ok', detail: `The app SP can read all ${fullNames.length} table(s).` });
    } else if (!applyGrants) {
      checks.push({
        id: 'sp', label: 'App can read source tables', status: 'fail',
        detail: 'The app SP cannot read every source table.',
        sql: spGrantStatements(spId, fullNames).map((g) => g.sql),
      });
    } else {
      const applied = await applySpGrants(req, warehouseId, spId, fullNames);
      void writeActivityEvent({
        eventType: 'sp_grant_applied', action: 'publish', userEmail: user.email || user.userName,
        shareName, recipientName, warehouseId,
        errorCode: applied.ok ? null : 'partial',
        metadata: { granted: applied.results.filter((r) => r.ok).length, total: applied.results.length },
      });
      if (!applied.ok) {
        const failed = applied.results.filter((r) => !r.ok);
        checks.push({
          id: 'sp', label: 'App can read source tables', status: 'fail',
          detail: `The app tried to grant the SP access as you, but ${failed.length} of ${applied.results.length} grants failed ` +
            `(you need MANAGE or ownership). Ask a catalog owner to run the SQL below, then re-check.`,
          sql: failed.map((r) => r.sql),
          errors: failed.map((r) => `${r.target}: ${r.error}`),
        });
      } else {
        probe = await spCanReadTables(warehouseId, fullNames);
        checks.push(probe.ok
          ? { id: 'sp', label: 'App can read source tables', status: 'ok', detail: `Granted the app SP read access on ${fullNames.length} table(s).` }
          : { id: 'sp', label: 'App can read source tables', status: 'warn',
              detail: `Grants applied, but the SP check still fails: ${probe.error}. If the SP lacks CAN USE on this warehouse, the check can't run; the job may still succeed.` });
      }
    }
  }

  // (e) Secret scope for TOKEN recipients
  const authType = conn ? conn.authenticationType : null;
  if (needsSecretScope(authType)) {
    const sc = await spCheckSecretScope(SDK_SECRET_SCOPE);
    const putAcl = `databricks secrets put-acl ${SDK_SECRET_SCOPE} ${spId || '<app-sp-client-id>'} READ`;
    if (sc.ok) {
      checks.push({ id: 'secret', label: 'SDK secret scope', status: 'ok', detail: `Scope ${SDK_SECRET_SCOPE} is readable by the app (${sc.keys.length} key(s)).` });
    } else if (sc.status === 404 || /does not exist|RESOURCE_DOES_NOT_EXIST/i.test(`${sc.code} ${sc.error}`)) {
      checks.push({
        id: 'secret', label: 'SDK secret scope', status: 'fail',
        detail: `This connection uses TOKEN authentication, and the SDK needs the secret scope ${SDK_SECRET_SCOPE}. It doesn't exist. ` +
          'Create it with the BDC Connect credentials (see FAQ), then give the app SP READ on it.',
        sql: [`databricks secrets create-scope ${SDK_SECRET_SCOPE}`, putAcl], fixKind: 'cli',
      });
    } else if (sc.status === 403 || /PERMISSION_DENIED/i.test(`${sc.code} ${sc.error}`)) {
      checks.push({
        id: 'secret', label: 'SDK secret scope', status: 'fail',
        detail: `The app SP can't read the secret scope ${SDK_SECRET_SCOPE}. A scope manager needs to grant READ.`,
        sql: [putAcl], fixKind: 'cli',
      });
    } else {
      checks.push({ id: 'secret', label: 'SDK secret scope', status: 'warn', detail: `Could not check the secret scope: ${sc.error}` });
    }
  } else if (conn) {
    checks.push({ id: 'secret', label: 'Connection authentication', status: 'ok', detail: `${authType || 'Unknown'} authentication, no secret scope needed.` });
  } else {
    checks.push({ id: 'secret', label: 'Connection found', status: 'warn', detail: `The BDC connection ${recipientName} is not visible to you. The GRANT will fail if it doesn't exist.` });
  }

  const ok = !checks.some((c) => c.status === 'fail');
  if (!ok) {
    void writeActivityEvent({
      eventType: 'publish_preflight_failed', action: 'publish', userEmail: user.email || user.userName,
      shareName, recipientName, warehouseId,
      errorCode: checks.filter((c) => c.status === 'fail').map((c) => c.id).join(','),
      errorMessage: checks.filter((c) => c.status === 'fail').map((c) => c.detail).join(' | '),
    });
  }
  return {
    ok, checks,
    share: share ? { name: share.name, owner: share.owner, isOwner: share.isOwner, bdcConnections: share.bdcConnections } : null,
    connection: conn,
    tables: detail.tables,
    objects: detail.objects,
  };
}
