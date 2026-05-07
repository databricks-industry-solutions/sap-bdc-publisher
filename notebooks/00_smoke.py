# Databricks notebook source
# MAGIC %md
# MAGIC # SDK Smoke Test
# MAGIC
# MAGIC CI-only notebook. Confirms the `sap-bdc-connect-sdk` package resolves in
# MAGIC the bundle's serverless environment and that the client + CSN generator
# MAGIC modules can be imported without error.
# MAGIC
# MAGIC No BDC API calls are made — instantiating `BdcConnectClient` with a
# MAGIC throwaway recipient name does not trigger the secret-scope read, that
# MAGIC happens lazily on the first publish/share call.

# COMMAND ----------

from bdc_connect_sdk.auth import BdcConnectClient, DatabricksClient
from bdc_connect_sdk.utils import csn_generator

# Synthetic recipient name — never used to make an API call. The constructor
# does not query Unity Catalog or BDC; it just stores the reference.
client = BdcConnectClient(DatabricksClient(dbutils, "smoke-test-recipient"))

assert hasattr(client, "create_or_update_share"), "BdcConnectClient missing expected method"
assert hasattr(csn_generator, "generate_csn_template"), "csn_generator missing expected function"

print("Smoke test OK: SDK imported and client constructed.")
dbutils.notebook.exit("ok")
