// Caller identity + group memberships, cached briefly per user. Group
// membership matters because shares are often owned by a group, not a
// person. v1 compared the owner to the user's email only.

import { getRequestUser } from '../auth.js';
import { getUserGroupsByEmail } from '../dbx.js';

const TTL_MS = 5 * 60_000;
const cache = new Map(); // email -> { groups, at }

export function norm(s) { return String(s || '').toLowerCase(); }

export function userKey(req) {
  const u = getRequestUser(req);
  return norm(u.userName || u.email);
}

export async function getIdentity(req) {
  const email = userKey(req);
  const hit = cache.get(email);
  if (hit && Date.now() - hit.at < TTL_MS) return { email, groups: hit.groups };
  const groups = (await getUserGroupsByEmail(req, email).catch(() => [])).map(norm);
  cache.set(email, { groups, at: Date.now() });
  return { email, groups };
}

export function ownsPrincipal(identity, owner) {
  const o = norm(owner);
  if (!o) return false;
  return o === identity.email || identity.groups.includes(o);
}
