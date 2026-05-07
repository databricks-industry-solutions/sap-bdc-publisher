// App service principal OAuth token (client_credentials) + cache. Databricks
// Apps injects DATABRICKS_CLIENT_ID / DATABRICKS_CLIENT_SECRET for the app's
// own service principal. We exchange these for a short-lived bearer token at
// {host}/oidc/v1/token and cache it until 60s before expiry.

import { getWorkspaceHost } from './auth.js';

const state = {
  token: null,
  expiresAt: 0,
  inflight: null,
};

function reqEnv(name) {
  const v = process.env[name];
  if (!v) {
    const err = new Error(
      `Missing env var ${name}. Databricks Apps should inject it automatically.`
    );
    err.status = 500;
    err.code = 'missing_sp_env';
    throw err;
  }
  return v;
}

async function fetchSpToken() {
  const host = getWorkspaceHost();
  if (!host) {
    const err = new Error('DATABRICKS_HOST not set');
    err.status = 500;
    throw err;
  }
  const clientId = reqEnv('DATABRICKS_CLIENT_ID');
  const clientSecret = reqEnv('DATABRICKS_CLIENT_SECRET');
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await fetch(`${host}/oidc/v1/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: 'grant_type=client_credentials&scope=all-apis',
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) {
    const err = new Error(
      `SP token fetch failed: ${body?.error_description || body?.error || 'HTTP ' + res.status}`
    );
    err.status = res.status;
    err.details = body;
    throw err;
  }
  const expiresIn = Number(body.expires_in || 3600);
  state.token = body.access_token;
  state.expiresAt = Date.now() + (expiresIn - 60) * 1000;
  return state.token;
}

export async function getSpToken() {
  if (state.token && Date.now() < state.expiresAt) return state.token;
  if (!state.inflight) {
    state.inflight = fetchSpToken()
      .finally(() => { state.inflight = null; });
  }
  return state.inflight;
}
