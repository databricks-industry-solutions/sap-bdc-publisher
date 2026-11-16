# Marketplace listing text (proposed for v2)

The listing text lives in the Marketplace provider console, not in this repo.
This is the proposed replacement. It drops the Asset Bundle wording for the
Marketplace path (the Marketplace install needs no bundle) and fixes the
privilege requirement.

## Short description

Publish Unity Catalog shares to SAP Business Data Cloud in a few clicks, and see what is shared and used.

## Description

The SAP BDC Data Share App publishes Delta Sharing shares from Unity Catalog to SAP Business Data Cloud through BDC Connect.

**What it does**

- Lists the shares you can publish and the BDC connections you can see.
- Checks a publish before it starts: supported object types, primary keys, your privileges, the app's access to the source tables, and the SDK secret scope for TOKEN connections. Missing access for the app is granted as you, or you get the SQL for a catalog owner.
- Runs the BDC Connect SDK steps (metadata, CSN schema with your primary keys, publish) on serverless compute as the app's service principal.
- Updates or unpublishes a share per BDC connection.
- Dashboard: shares and tables in BDC, publish success and failures by reason, source changes since the last publish, and optional SAP read activity from the audit log.
- Activity log of who published what, in a Delta table you choose.

**Requirements**

- Unity Catalog and Delta Sharing, and a SQL warehouse.
- A BDC Connect connection to this workspace (a Delta Sharing recipient created by SAP BDC).
- To publish: ownership of the share and `USE RECIPIENT`, or `USE RECIPIENT`, `USE SHARE` and `SET SHARE PERMISSION`.
- No workspace admin rights for the user or the app.

**Install**

Install from Marketplace and open the app. No Asset Bundle is needed. To change the source, deploy the Asset Bundle from the GitHub repository instead.
