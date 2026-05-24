# Databricks → SAP BDC Publisher

[![Databricks](https://img.shields.io/badge/Databricks-Solution_Accelerator-FF3621?style=for-the-badge&logo=databricks)](https://databricks.com)
[![Unity Catalog](https://img.shields.io/badge/Unity_Catalog-Enabled-00A1C9?style=for-the-badge)](https://docs.databricks.com/en/data-governance/unity-catalog/index.html)
[![Delta Sharing](https://img.shields.io/badge/Delta_Sharing-Required-1B3139?style=for-the-badge)](https://docs.databricks.com/en/delta-sharing/index.html)

A Databricks App that automates publishing a Unity Catalog share to SAP
Business Data Cloud (BDC Connect) in a few clicks. Replaces the manual
notebook workflow (run SQL, call BDC SDK, publish data product) with a
guided UI.

---

## Installation

This repo ships as a Databricks Solution Accelerator — a repo you clone
into your workspace and deploy via the Asset Bundle Editor.

1. **Get the code into your workspace**, either:
   - **Marketplace**: find **SAP BDC Publisher** → click **Get access** →
     pick a workspace folder. The repo is cloned for you.
   - **GitHub direct**: in Databricks Workspace → **Clone from GitHub** →
     paste this repo URL.

2. **Open the Asset Bundle Editor** on the cloned `databricks.yml` (the
   UI auto-detects it).

3. **Click "Deploy"**. The bundle provisions:
   - The `bdc-sharing` Databricks App (with the `sql` user-API scope
     already set — no manual scope grant needed) and uploads the app
     source under `./apps/bdc-sharing/` to a bundle-managed workspace
     path.
   - The `bdc_publish` and `bdc_unpublish` notebooks at
     `<bundle-files>/notebooks/`, which the app calls at runtime.

4. **Start the app**. The bundle deploy registers the App and binds
   its source, but does not start it on compute (this is documented
   DAB behavior). Open the App's page in the Databricks Apps UI and
   click **Deploy**. Wait for the state to reach **Running**.

   CLI alternative:
   ```bash
   databricks apps deploy bdc-sharing
   ```

5. **Grant the app SP `CAN_USE` on at least one SQL warehouse** so the
   in-app warehouse dropdown is non-empty:

   ```bash
   databricks warehouses set-permissions <warehouse-id> \
     --json '{"access_control_list":[
       {"service_principal_name":"<bdc-sharing-sp-client-id>","permission_level":"CAN_USE"}
     ]}'
   ```

6. **Open the App URL** from the App's page and start publishing. The
   Activity tab launches a one-time setup sub-wizard on first visit
   (provisions or adopts a Delta table for the audit log; takes ~10
   seconds).

---

## Prerequisites

| What | Why |
|---|---|
| Unity Catalog + Delta Sharing enabled in the workspace | shares and recipients live here |
| At least one serverless SQL warehouse | used for `SHOW`/`DESCRIBE` queries and for the activity-log writes |
| An SAP BDC Connect recipient with `authentication_type = OIDC_FEDERATION` (typically named `bdc-connect-*`) | the BDC publish target. **`TOKEN`-type recipients require additional workspace setup — see the FAQ entry "Publish fails with 'Secret does not exist with scope: sap-bdc-connect-sdk'"** |
| Workspace user with `ALTER` (or ownership) on the share you want to publish | UC enforces this when the app issues `GRANT SELECT ON SHARE` |

The app **does not** require workspace-admin rights for either the user or
the service principal. UC privileges on the share + `CAN_USE` on a
warehouse are sufficient.

---

## How it works

The app uses **two identities** simultaneously — a hybrid auth model:

| Identity | Used for |
|---|---|
| **End user** (via OBO token, scope `sql`) | All UC reads (`SHOW SHARES`, `SHOW RECIPIENTS`, `DESCRIBE …`, `SHOW GRANTS …`), and the privilege mutations on the share itself: `GRANT SELECT ON SHARE` (publish) and `REVOKE SELECT ON SHARE` (delete). UC enforces ownership / `ALTER` on the share against the user's identity. |
| **App service principal** | Listing + starting SQL warehouses, submitting the BDC publish/delete Jobs, polling job status. The Job itself runs as the SP — **no `run_as`, no workspace-admin requirement**. The Job only calls the BDC SDK, which doesn't depend on user identity. |

Audit trail stays coherent: `system.access.audit` shows GRANT/REVOKE
attributed to the user; the BDC SDK calls are attributed to the SP. The
app's own activity log (configured via the in-app wizard) merges both
views.

```
┌────────────────┐       ┌─────────────────────┐       ┌──────────────────┐
│   Browser      │◄─────►│ Express (Node)      │──────►│ Databricks APIs  │
│ static HTML +  │ HTTPS │  - /api/me          │ SP +  │  - SQL Warehouses│
│ vanilla JS     │       │  - /api/warehouses  │ OBO   │  - Statement Exec│
└────────────────┘       │  - /api/shares      │       │  - Jobs 2.2      │
                         │  - /api/recipients  │       │  - SCIM /Me      │
                         │  - /api/grants      │       │  - Apps (self)   │
                         │  - /api/publish     │       │  - Workspace I/O │
                         │  - /api/unpublish   │       └────────┬─────────┘
                         │  - /api/activity    │                │
                         │  - /api/setup       │                ▼
                         └─────────────────────┘      ┌────────────────────┐
                                                      │ Serverless Jobs    │
                                                      │ run as the SP      │
                                                      │  - bdc_publish.py  │
                                                      │  - bdc_unpublish.py│
                                                      └────────────────────┘
```

---

## Repo layout

```
.
├── apps/bdc-sharing/        # Databricks App source
│   ├── app.yaml             # Apps runtime config (command, env, scopes)
│   ├── package.json         # Express + npm
│   ├── public/              # Static UI (HTML/CSS/vanilla JS)
│   └── server/              # Express backend (routes/, dbx.js, auth.js, …)
├── notebooks/
│   ├── bdc_publish.py       # Invoked by the app at runtime
│   ├── bdc_unpublish.py     # Invoked by the app at runtime
│   └── 00_smoke.py          # CI-only smoke test
├── databricks.yml           # Asset Bundle (apps + smoke job)
├── requirements.txt         # Python deps for the notebooks
└── env.example              # App env vars (sourced from app.yaml at deploy)
```

---

## Contributing

PRs welcome. By submitting a contribution you accept the terms in
[`CONTRIBUTING.md`](./CONTRIBUTING.md).

For local iteration, the fastest loop is:

```bash
databricks bundle validate           # Confirm bundle is well-formed
databricks bundle deploy             # Deploy app + notebooks to your workspace
databricks bundle run demo_workflow  # Sanity-check the SDK installs
```

CI on every PR runs the same against the workspace configured via the
`DATABRICKS_HOST` repo variable (see `.github/workflows/databricks-ci.yml`)
and tears down the deployment afterward.

---

## Third-Party Package Licenses

&copy; 2026 Databricks, Inc. All rights reserved. Source provided subject to
the [Databricks License](./LICENSE.md). Third-party libraries:

| Package | License | Copyright |
|---|---|---|
| [express](https://github.com/expressjs/express) | MIT | © OpenJS Foundation and Express contributors |
| [sap-bdc-connect-sdk](https://pypi.org/project/sap-bdc-connect-sdk/) | SAP Developer License | © SAP SE |
| [databricks-sdk](https://pypi.org/project/databricks-sdk/) | Apache-2.0 | © Databricks, Inc. |
