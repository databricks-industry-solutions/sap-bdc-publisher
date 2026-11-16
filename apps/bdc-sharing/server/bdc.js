// Single source of truth for "is this recipient a BDC Connect connection".
// v1 had two different regexes (shares vs recipients) that could disagree.
//
// BDC Connect creates recipients named `bdc-connect-<id>` today. Customers
// who renamed them, or future naming schemes, can override the match with
// BDC_RECIPIENT_PATTERN (a JavaScript regex, case-insensitive).

const DEFAULT_PATTERN = 'bdc.*connect|connect.*bdc';

function buildRe() {
  const raw = (process.env.BDC_RECIPIENT_PATTERN || '').trim();
  try {
    return new RegExp(raw || DEFAULT_PATTERN, 'i');
  } catch (e) {
    console.error('[bdc] invalid BDC_RECIPIENT_PATTERN, using default', e.message);
    return new RegExp(DEFAULT_PATTERN, 'i');
  }
}

const BDC_RE = buildRe();

export function isBdcRecipient(nameOrRecipient) {
  const name = typeof nameOrRecipient === 'string'
    ? nameOrRecipient
    : (nameOrRecipient && (nameOrRecipient.name || nameOrRecipient.recipient_name)) || '';
  return BDC_RE.test(name);
}

export function bdcRecipientPattern() {
  return BDC_RE.source;
}

// The SDK reads a secret scope for TOKEN (open sharing) recipients. OIDC
// federated recipients don't need it.
export const SDK_SECRET_SCOPE = 'sap-bdc-connect-sdk';
export function needsSecretScope(authenticationType) {
  return String(authenticationType || '').toUpperCase() === 'TOKEN';
}

// Views and materialized views are blocked by default. Set BDC_ALLOW_VIEWS
// to "true" once BDC Connect support for views is confirmed for your
// landscape (see FAQ).
export function viewsAllowed() {
  return String(process.env.BDC_ALLOW_VIEWS || '').toLowerCase() === 'true';
}
export const VIEW_TYPES = new Set(['VIEW', 'MATERIALIZED_VIEW', 'STREAMING_TABLE']);
