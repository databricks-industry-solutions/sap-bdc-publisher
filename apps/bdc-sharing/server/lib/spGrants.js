// GRANT USE CATALOG / USE SCHEMA / SELECT to the app SP on every source
// table of a share. The BDC publish job runs as the SP, so without these the
// CSN generation fails inside the job. Runs as the user (OBO); the user
// needs MANAGE or ownership on each object.

import { executeStatement, idQ } from '../dbx.js';

export function spGrantStatements(spId, fullNames) {
  const catalogs = new Set();
  const schemas = new Set();
  const tables = [];
  for (const fullName of fullNames) {
    const parts = String(fullName).split('.');
    if (parts.length !== 3) continue;
    const [cat, sch, tbl] = parts;
    catalogs.add(cat);
    schemas.add(`${cat}\0${sch}`);
    tables.push({ cat, sch, tbl, fullName });
  }
  const spQ = idQ(spId);
  const out = [];
  for (const c of catalogs) out.push({ scope: 'catalog', target: c, sql: `GRANT USE CATALOG ON CATALOG ${idQ(c)} TO ${spQ}` });
  for (const s of schemas) {
    const [c, sch] = s.split('\0');
    out.push({ scope: 'schema', target: `${c}.${sch}`, sql: `GRANT USE SCHEMA ON SCHEMA ${idQ(c)}.${idQ(sch)} TO ${spQ}` });
  }
  for (const t of tables) {
    out.push({ scope: 'table', target: t.fullName, sql: `GRANT SELECT ON TABLE ${idQ(t.cat)}.${idQ(t.sch)}.${idQ(t.tbl)} TO ${spQ}` });
  }
  return out;
}

export async function applySpGrants(req, warehouseId, spId, fullNames) {
  const grants = spGrantStatements(spId, fullNames);
  const results = [];
  // Sequential on purpose: catalog before schema before table.
  for (const g of grants) {
    try {
      await executeStatement(req, { statement: g.sql, warehouseId });
      results.push({ ...g, ok: true });
    } catch (e) {
      results.push({ ...g, ok: false, error: e.message });
    }
  }
  return { ok: results.every((r) => r.ok), results };
}
