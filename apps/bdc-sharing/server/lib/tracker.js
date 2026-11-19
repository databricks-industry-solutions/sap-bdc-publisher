// Usage tracking for the dbdemos-tracker (see README, "Data collection").
// Every page view is sent; the email only for @databricks.com users, hashed.
// Anyone else is an anonymous view. Fire-and-forget: never awaited, errors
// ignored. Off when DBDEMOS_TRACKER_DISABLED=1.

import { createHash } from 'node:crypto';

const DEMO_NAME = 'sap-bdc-data-share-app-cb0a';

export function trackView(req, appPath, orgId) {
  if (process.env.DBDEMOS_TRACKER_DISABLED === '1') return;
  try {
    const body = {
      category: 'demo-app', event: 'APP-VIEW', version: '1', demo_name: DEMO_NAME,
      org_id: orgId, path: `/_dbdemos/demo-app/${DEMO_NAME}`, app_path: appPath,
    };
    const email = req.headers['x-forwarded-email'];
    if (typeof email === 'string' && email.endsWith('@databricks.com')) body.user_hash = createHash('sha256').update(email).digest('hex');
    fetch('https://ppxrzfxige.execute-api.us-west-2.amazonaws.com/v1/analytics', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(2000),
    }).catch(() => {});
  } catch { /* tracking must never break a page */ }
}
