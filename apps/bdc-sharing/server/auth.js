// Auth helpers. We now use the app service principal (SP) OAuth token for all
// Databricks API calls — Databricks Apps injects DATABRICKS_CLIENT_ID /
// DATABRICKS_CLIENT_SECRET for the SP. The end-user's identity is captured
// from the forwarded headers the Apps runtime injects on every request
// (x-forwarded-email / x-forwarded-preferred-username / x-forwarded-user).

export function getWorkspaceHost() {
  let host = process.env.DATABRICKS_HOST || '';
  if (host && !host.startsWith('http')) host = `https://${host}`;
  return host.replace(/\/+$/, '');
}

export function requireHost() {
  const host = getWorkspaceHost();
  if (!host) {
    const err = new Error(
      'DATABRICKS_HOST is not set. This app must run inside Databricks Apps.'
    );
    err.status = 500;
    err.code = 'missing_host';
    throw err;
  }
  return host;
}

// Extract the end-user identity from the forwarded headers injected by the
// Databricks Apps runtime. This does NOT require a user OBO token — it is
// the identity the platform verified via SSO.
// User OBO token injected by the Databricks Apps runtime. Required for
// user-scoped reads (shares, recipients, describe, SQL queries). Warehouse
// start and Jobs submit use the SP token instead (see spAuth.js).
export function getUserToken(req) {
  const token =
    req.header('x-forwarded-access-token') ||
    req.header('X-Forwarded-Access-Token');
  if (!token) {
    const err = new Error(
      'Missing user OBO token (x-forwarded-access-token). ' +
        'The app must run inside Databricks Apps with user authorization enabled.'
    );
    err.status = 401;
    err.code = 'missing_user_token';
    throw err;
  }
  return token;
}

export function getRequestUser(req) {
  const email =
    req.header('x-forwarded-email') ||
    req.header('X-Forwarded-Email') ||
    null;
  const preferredUsername =
    req.header('x-forwarded-preferred-username') ||
    req.header('X-Forwarded-Preferred-Username') ||
    null;
  const user =
    req.header('x-forwarded-user') ||
    req.header('X-Forwarded-User') ||
    null;

  const userName = email || preferredUsername || user || null;
  return {
    userName,
    email,
    preferredUsername,
    user,
  };
}

export function requireRequestUser(req) {
  const u = getRequestUser(req);
  if (!u.userName) {
    const err = new Error(
      'Could not resolve the logged-in user from forwarded headers. ' +
        'Databricks Apps should inject x-forwarded-email on every request.'
    );
    err.status = 401;
    err.code = 'no_forwarded_user';
    throw err;
  }
  return u;
}
