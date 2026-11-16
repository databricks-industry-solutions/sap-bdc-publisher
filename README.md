# Databricks → SAP BDC Publisher

[![Databricks](https://img.shields.io/badge/Databricks-Marketplace_App-FF3621?style=for-the-badge&logo=databricks)](https://databricks.com)
[![Unity Catalog](https://img.shields.io/badge/Unity_Catalog-Enabled-00A1C9?style=for-the-badge)](https://docs.databricks.com/en/data-governance/unity-catalog/index.html)
[![Delta Sharing](https://img.shields.io/badge/Delta_Sharing-Required-1B3139?style=for-the-badge)](https://docs.databricks.com/en/delta-sharing/index.html)

A Databricks App that publishes Unity Catalog shares to SAP Business Data
Cloud (BDC Connect). Pick a share, pick a BDC connection, publish. The app
checks the prerequisites first, grants its own service principal the access
the BDC SDK needs, and runs the SDK steps for you. A Dashboard shows what is
in BDC, how publishing goes, and (optionally) how much SAP reads.

---

## Installation

Two paths. Pick **Option A** unless you need to customize the source
before deploy.

### Option A: Databricks Marketplace (recommended)

1. In Databricks: open **Marketplace**, search **SAP BDC Publisher**,
   click **Get access**. You're redirected to the Apps view with a
   two-step install dialog.
2. **Review authorization and metadata.** Inspect the User
   Authorization scope (`sql`) and the App Authorization scope.
   Optionally set the App name, Description, and Serverless usage
   policy.
3. Click **Install**. The platform deploys the app; no bundle, no
   deploy job, no SP grant step required.
4. Open the App URL from the app's page. The Activity tab launches a
   one-time setup sub-wizard on first visit (provisions or adopts a
   Delta table for the audit log; ~10 seconds). Start publishing.

### Option B: Asset Bundle from GitHub (manual)

For development, self-hosting, or customizing the app source before
deploy.

1. **Get the code into your workspace**, either:
   - In Databricks Workspace, **Clone from GitHub**, paste this repo URL.
   - Or open the repo in the Marketplace and click **Get access** to
     have it cloned into a workspace folder.

2. **Open the Asset Bundle Editor** on the cloned `databricks.yml` (the
   UI auto-detects it).

3. **Click "Deploy"** in the Asset Bundle Editor. This uploads the app
   source under `./apps/bdc-sharing/` to a bundle-managed workspace
   path, registers the `bdc-sharing` Databricks App resource (with the
   `sql` user-API scope already set), stages the
   `bdc_publish` / `bdc_unpublish` notebooks the app calls at runtime,
   and creates the **SAP BDC sharing** AI/BI dashboard. The dashboard
   uses the warehouse named "Serverless Starter Warehouse" and expects
   the activity table at `main.bdc_sharing.activity`; override with
   `--var warehouse_id=<id> --var activity_catalog=<catalog> --var activity_schema=<schema>`
   when deploying from the CLI.
   The app itself comes up **UNAVAILABLE** at this point: bundle
   deploy does not bind source to the app on its own.

4. **Run the `deploy_bdc_sharing_app` job** from the Asset Bundle UI's
   Runs tab (🚀 icon, click **Run** next to the job). This starts the
   app compute and calls the Apps Deploy API with the source path the
   bundle uploaded. Takes ~2 minutes. The app reaches **RUNNING**.

5. **(If the in-app warehouse dropdown is empty)** the warehouse list
   is OBO-driven, so the picker reflects warehouses **you** have
   `CAN_USE` on. If you have access but the SP needs to start the
   warehouse on your behalf and lacks `CAN_USE`, an admin can grant it:

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
| An SAP BDC Connect recipient with `authentication_type = OIDC_FEDERATION` (typically named `bdc-connect-*`) | the BDC publish target. **`TOKEN`-type recipients need a workspace secret scope. Pre-flight checks it; see the FAQ entry on `sap-bdc-connect-sdk`.** |
| A user who owns the share and has `USE RECIPIENT`, or has `USE RECIPIENT` + `USE SHARE` + `SET SHARE PERMISSION` | UC enforces this when the app issues `GRANT SELECT ON SHARE` |

The app **does not** require workspace-admin rights for either the user or
the service principal. UC privileges on the share + `CAN_USE` on a
warehouse are sufficient.

---

## How it works

The app uses **two identities**:

| Identity | Used for |
|---|---|
| **End user** (via OBO token, scope `sql`) | Listing SQL warehouses, all UC reads (one `system.information_schema` query lists every share with its BDC grants; `SHOW ALL IN SHARE` and one `information_schema.columns` query cover a share's tables and keys), the SP grants on source tables during pre-flight, and the privilege changes on the share: `GRANT SELECT ON SHARE` (publish) and `REVOKE SELECT ON SHARE` (unpublish). |
| **App service principal** | Starting warehouses, submitting and polling the BDC publish/unpublish jobs, pre-flight probes (can the SP read the source tables, is the SDK secret scope readable), activity log writes, the run reconciler, and the optional audit-log read for SAP usage. The job runs as the SP, **no `run_as`, no workspace-admin requirement**. |

`system.access.audit` shows GRANT/REVOKE under the user and the SDK calls
under the SP. The app's activity log (set up in the app) ties both together.

Reliability:

- Every API request answers within 25 seconds. Slow work (a cold warehouse,
  a large metastore) continues in the background and the page waits for it,
  so the Apps proxy never returns a bare `HTTP 502` for a slow query.
- Job outcomes are recorded server-side. A reconciler checks unfinished runs
  every minute, so closing the tab no longer loses the result. A finished
  unpublish whose REVOKE didn't run yet is "revoke pending" and completes
  on the user's next visit.

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
                         │  - /api/dashboard   │                │
                         │  - /api/activity    │                ▼
                         └─────────────────────┘      ┌────────────────────┐
                                                      │ Serverless Jobs    │
                                                      │ run as the SP      │
                                                      │  - bdc_publish.py  │
                                                      │  - bdc_unpublish.py│
                                                      └────────────────────┘
```

---

## Dashboard

One page, three tiers. A tier that isn't set up shows the exact step to
enable it instead of an error.

| Tier | Needs | Shows |
|---|---|---|
| Inventory | nothing extra (your own UC access) | shares in BDC, BDC connections in use, tables, tables without a UC primary key, source tables changed after the last publish |
| Publishing | the activity log | publish success rate, activity per day, failures by reason (linked to the FAQ), last publish per share, top publishers (admins) |
| SAP reads | optional grant to the app SP (below) | queries, rows and bytes read per BDC connection and table, last read |

The same data is available as an **AI/BI dashboard**
(`apps/bdc-sharing/dashboards/bdc_sharing.lvdash.json`) for slicing,
schedules and sharing: two pages (Publishing, SAP reads) with date, share
and BDC connection filters. The bundle deploys it; Marketplace installs
download it from the app's Dashboard page (the file comes with your
activity table filled in) and use *Import dashboard from file*. It runs
with each viewer's permissions.

A "Needs attention" list collects: source changed after publish (Update in
BDC), revoke pending (Finish), last publish failed, and published but not
read by SAP for the selected window.

To enable SAP reads, a metastore admin runs:

```sql
GRANT USE CATALOG ON CATALOG system TO `<app-sp-client-id>`;
GRANT USE SCHEMA ON SCHEMA system.access TO `<app-sp-client-id>`;
GRANT SELECT ON TABLE system.access.audit TO `<app-sp-client-id>`;
```

The SP can then read the whole audit table. The app only queries Delta
Sharing query events for BDC connections the viewer can see. If that
trade-off doesn't fit, skip the grant or set `BDC_USAGE_FROM_AUDIT=false`.

---

## Configuration

All optional, set in `app.yaml`.

| Variable | Default | Effect |
|---|---|---|
| `BDC_ACTIVITY_TABLE` | empty | Pin the activity log table (3-part name). Empty means the in-app wizard sets it. |
| `BDC_ACTIVITY_ADMIN_GROUP` | `admins` | Members see all users' events on the Activity page and Dashboard. |
| `BDC_RECIPIENT_PATTERN` | `bdc.*connect\|connect.*bdc` | Regex that marks a recipient as a BDC connection. |
| `BDC_ALLOW_VIEWS` | `false` | Allow views in published shares once BDC Connect support is confirmed for your landscape. |
| `BDC_USAGE_FROM_AUDIT` | `true` | Set to `false` to hide the SAP reads tier. |
| `BDC_REQUEST_BUDGET_MS` | `25000` | Time a request may take before the app answers "still working". Keep it below the Apps proxy timeout. |

Troubleshooting: `/api/health?deep=true&warehouseId=<id>` checks the SP
token, the warehouse and the activity log; `/api/diag` shows the SQL the app
runs and compares `information_schema` with `SHOW GRANTS` on a sample of
shares.

---

## Repo layout

```
.
├── apps/bdc-sharing/        # Databricks App source: everything that ships to Marketplace
│   ├── README.md            # In-app docs, served at /README.md (identical to this file)
│   ├── app.yaml             # Apps runtime config (command, env, scopes)
│   ├── dashboards/          # AI/BI dashboard (deployed by the bundle, downloadable in the app)
│   ├── manifest.yaml        # Databricks Marketplace listing manifest
│   ├── package.json         # Express + npm
│   ├── notebooks/
│   │   ├── bdc_publish.py   # Submitted by the publish route at runtime
│   │   └── bdc_unpublish.py # Submitted by the delete route at runtime
│   ├── public/              # Static UI: index.html (Publish), dashboard.html, activity.html, faq.html, docs.html, common.js, app.css
│   └── server/              # Express backend: routes/, lib/ (request budget, pre-flight, SP grants), runs.js (reconciler), activity.js, dbx.js, …
├── notebooks/
│   └── deploy_app.py        # DAB-only deploy job: binds app source + grants SP read (Option B)
├── databricks.yml           # Asset Bundle definition (Option B install path): app, deploy job, AI/BI dashboard
├── requirements.txt         # Python deps for the runtime notebooks
└── env.example              # App env vars (mirrored from app.yaml for local reference)
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
