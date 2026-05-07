# Databricks notebook source
# MAGIC %md
# MAGIC # BDC Publish Notebook
# MAGIC
# MAGIC Parameterized notebook invoked by the Data Sharing app. Registers and
# MAGIC publishes the share as a data product in SAP Business Data Cloud.
# MAGIC Supports injecting primary keys into the CSN schema for tables that
# MAGIC do not define one in Unity Catalog.
# MAGIC
# MAGIC The `GRANT SELECT ON SHARE` is executed by the app server *before*
# MAGIC submitting this Job, using the user's OBO identity. This notebook
# MAGIC therefore runs as the app SP and does not need workspace-admin
# MAGIC privileges or `run_as`.

# COMMAND ----------

dbutils.widgets.text("recipient_name", "", "Recipient name")
dbutils.widgets.text("share_name", "", "Share name")
dbutils.widgets.text("title", "", "Data product title")
dbutils.widgets.text("short_description", "", "Short description")
dbutils.widgets.text("description", "", "Long description")
dbutils.widgets.text("primary_keys_json", "{}", "Primary keys JSON map")

recipient_name = dbutils.widgets.get("recipient_name").strip()
share_name = dbutils.widgets.get("share_name").strip()
title = dbutils.widgets.get("title").strip() or share_name
short_description = dbutils.widgets.get("short_description").strip() or share_name
description = dbutils.widgets.get("description").strip() or f"Published from Data Sharing app: {share_name}"
primary_keys_json = dbutils.widgets.get("primary_keys_json").strip() or "{}"

assert recipient_name, "recipient_name widget is required"
assert share_name, "share_name widget is required"

import json
try:
    pk_reference = json.loads(primary_keys_json) or {}
except Exception as e:
    raise ValueError(f"primary_keys_json is not valid JSON: {e}")

print(f"share_name     = {share_name}")
print(f"recipient_name = {recipient_name}")
print(f"title          = {title}")
print(f"pk_reference   = {pk_reference}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Set up the BDC Connect client

# COMMAND ----------

from bdc_connect_sdk.auth import BdcConnectClient, DatabricksClient
from bdc_connect_sdk.utils import csn_generator

bdc_connect_client = BdcConnectClient(DatabricksClient(dbutils, recipient_name))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Step 1 — create or update the ORD descriptor on the BDC side

# COMMAND ----------

open_resource_discovery_information = {
    "@openResourceDiscoveryV1": {
        "title": title,
        "shortDescription": short_description,
        "description": description,
    }
}
bdc_connect_client.create_or_update_share(share_name, open_resource_discovery_information)
print("Step 1 OK: share metadata upserted")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Step 2 — generate CSN schema template

# COMMAND ----------

csn_schema = csn_generator.generate_csn_template(share_name)
print(f"Step 2 OK: generated CSN with {len(csn_schema.get('definitions', {}))} entities")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Step 2b — apply user-supplied primary keys to the CSN (before upsert)
# MAGIC
# MAGIC For entities that already have a PK defined in Unity Catalog, BDC picks
# MAGIC it up automatically. For entities without one, the Data Sharing app
# MAGIC collects PK column names from the user and passes them here. We mark
# MAGIC matching elements with `key: True` and `notNull: True` to satisfy BDC's
# MAGIC requirement that every published data asset have a primary key.

# COMMAND ----------

if pk_reference:
    applied = 0
    for entity_name, entity_def in csn_schema.get("definitions", {}).items():
        elements = entity_def.get("elements", {})
        entity_pks = [pk.lower() for pk in pk_reference.get(entity_name, [])]
        if not entity_pks:
            continue
        for field_name, props in elements.items():
            if field_name.lower() in entity_pks:
                props["key"] = True
                props["notNull"] = True
                applied += 1
                print(f"  set key+notNull on {entity_name}.{field_name}")
    print(f"Step 2b OK: applied {applied} primary-key annotation(s)")
else:
    print("Step 2b skipped: no user-supplied primary keys")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Step 2c — upsert the CSN schema to BDC

# COMMAND ----------

bdc_connect_client.create_or_update_share_csn(share_name, csn_schema)
print("Step 2c OK: CSN schema upserted")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Step 3 — publish the data product

# COMMAND ----------

bdc_connect_client.publish_data_product(share_name)
print("Step 3 OK: data product published")

# COMMAND ----------

dbutils.notebook.exit(
    f"Published share '{share_name}' to recipient '{recipient_name}'"
)
