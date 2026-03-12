# How to Run Neo4j Cleanup

This guide provides the sequence of commands to safely align your Neo4j database with the approved CortexDrive schema.

---

## 🛡 safety First: Run an Audit
Before performing any deletions, run the audit to see exactly what will be removed. This generates a JSON report in your terminal.

```bash
uv run audit_model.py --mode audit
```

## 🧹 Option 1: Incremental Purge (Recommended)
This mode specifically targets nodes and relationships that are not in the "Golden List". It will ask for confirmation before proceeding.

```bash
uv run audit_model.py --mode purge-illegal
```

## 🏷 Option 2: Multi-Tenancy Repair
If you have nodes without a `tenant_id`, run this to retroactively tag them. 

By default, the script follows this hierarchy:
1. **`TENANT_ID`** from `.env` (Primary)
2. **`TEST_TENANT`** from `.env` (Fallback)
3. **`"test-tenant"`** (Hardcoded default)

### Use Defaults
```bash
uv run audit_model.py --mode fix-tenant
```

### Change "On the Fly"
To override the default hierarchy and use a specific ID for one run:
```bash
uv run audit_model.py --mode fix-tenant --tenant-id test_org_123
```

## 🚀 Option 3: Full Production Cleanup
Runs both the tenant fix and the illegal data purge in one go.

```bash
uv run audit_model.py --mode full-cleanup
```

> [!NOTE]
> All cleanup modes that require a `tenant_id` support the `--tenant-id` argument to override the environment configuration. This is useful for migrating data to a new Clerk Organization without changing your permanent `.env` file.

---

---

## ✅ Post-Cleanup Verification
After running any of the cleanup commands, run the snapshot script to confirm your database is now 100% schema-compliant:

```bash
uv run snapshot_status_quo.py
```

Review the newly generated report in `documents/` and check the **⚠️ Schema Violations** section. It should now be empty or significantly reduced.
