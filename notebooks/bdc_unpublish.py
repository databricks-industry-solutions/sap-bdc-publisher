# Databricks notebook source
# MAGIC %md
# MAGIC # BDC Unpublish Notebook
# MAGIC
# MAGIC Reverses what `bdc_publish.py` does. Parameterized notebook invoked by
# MAGIC the Data Sharing app when a user toggles to **Delete** mode.
# MAGIC
# MAGIC Single step: `delete_share` on the BDC side. The SDK call removes the
# MAGIC BDC catalog entry, revokes BDC-side recipient access, and deletes the
# MAGIC ORD descriptor + CSN schema. It is the only teardown method the SDK
# MAGIC exposes (no separate `unpublish_data_product`).
# MAGIC
# MAGIC The `REVOKE SELECT ON SHARE` on the Databricks side is executed by
# MAGIC the app server *after* this Job lands SUCCESS, via the
# MAGIC `/api/unpublish/:runId/finalize` endpoint, using the user's OBO
# MAGIC identity. Deferring the REVOKE to after-success ensures consumers
# MAGIC don't lose SELECT mid-read if the BDC teardown fails. This notebook
# MAGIC therefore runs as the app SP and does not need workspace-admin
# MAGIC privileges or `run_as`.

# COMMAND ----------

dbutils.widgets.text("recipient_name", "", "Recipient name")
dbutils.widgets.text("share_name", "", "Share name")

recipient_name = dbutils.widgets.get("recipient_name").strip()
share_name = dbutils.widgets.get("share_name").strip()

assert recipient_name, "recipient_name widget is required"
assert share_name, "share_name widget is required"

print(f"share_name     = {share_name}")
print(f"recipient_name = {recipient_name}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Set up the BDC Connect client

# COMMAND ----------

from bdc_connect_sdk.auth import BdcConnectClient, DatabricksClient

bdc_connect_client = BdcConnectClient(DatabricksClient(dbutils, recipient_name))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Delete the share on the BDC side
# MAGIC
# MAGIC Single SDK teardown call. Removes catalog entry, revokes BDC-side
# MAGIC recipient access, deletes ORD + CSN. If this fails, the notebook
# MAGIC stops — and the app server will not run REVOKE either, so
# MAGIC consumers can keep reading until the operator retries.

# COMMAND ----------

bdc_connect_client.delete_share(share_name)
print("OK: BDC share deleted (catalog entry, ORD, CSN)")

# COMMAND ----------

dbutils.notebook.exit(
    f"Deleted share '{share_name}' from recipient '{recipient_name}'"
)
