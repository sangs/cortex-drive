# How-To: Google Cloud Operations — CortexDrive

Reference for inspecting and operating the CortexDrive cloud infrastructure.
Project: `cortex-drive-496915` | Region: `us-central1`

---

## Service Accounts Reference

Two service accounts appear throughout this document. They serve completely different
purposes — do not confuse them.

| Service Account | Kind | Used for |
|---|---|---|
| `377406326936-compute@developer.gserviceaccount.com` | **Compute Engine default SA** | Identity assumed by Cloud Run services. This is what you grant `secretAccessor`, `cloudsql.client`, and `run.invoker` roles to. |
| `p377406326936-wr039e@gcp-sa-cloud-sql.iam.gserviceaccount.com` | **Cloud SQL service agent** | Internal GCP-managed SA used by Cloud SQL itself for encryption and backup operations. Never use this in IAM bindings for secrets or other services. |

**Where to find them in GCP Console:**

- **Compute Engine default SA** (`...compute@developer.gserviceaccount.com`):
  GCP Console → **IAM & Admin → Service Accounts** → look for display name
  "Compute Engine default service account". This is the identity of all Cloud Run
  services in this project unless a custom SA is specified.

- **Cloud SQL service agent** (`p377406326936-wr039e@gcp-sa-cloud-sql.iam.gserviceaccount.com`):
  GCP Console → **IAM & Admin → IAM** → tick "Include Google-provided role grants" →
  look for the `roles/cloudsql.serviceAgent` binding. It does not appear in the
  Service Accounts list because it is a Google-managed system account, not a
  user-created one. You noted this account when viewing the Cloud SQL instance
  details — it is used internally by Cloud SQL and requires no action from you.

**Rule:** Every `--member="serviceAccount:..."` in this document refers to the
Compute Engine default SA (`377406326936-compute@developer.gserviceaccount.com`),
never to the Cloud SQL service agent.

---

## Cloud Run Services

| Service | Custom URL | Raw Cloud Run URL | Ingress |
|---|---|---|---|
| `cortex-ui` | `https://app.cortex-drive.com` | `cortex-ui-isabiovosq-uc.a.run.app` | public |
| `cortex-gateway` | `https://api.cortex-drive.com` | `cortex-gateway-isabiovosq-uc.a.run.app` | public |
| `cortex-mcp` | — | `cortex-mcp-isabiovosq-uc.a.run.app` | all + OIDC |
| `cortex-bento` | — | `cortex-bento-isabiovosq-uc.a.run.app` | internal |
| `cortex-openfga` | — | `cortex-openfga-isabiovosq-uc.a.run.app` | all + OIDC |
| `cortex-permify` | — | `cortex-permify-isabiovosq-uc.a.run.app` | all + OIDC |

---

## Cloud Run Proxy — How `gcloud run services proxy` Works

Several scripts in this project reach private Cloud Run services (`cortex-permify`,
`cortex-openfga`, `cortex-mcp`) that require OIDC auth. Rather than managing tokens
manually, they use the proxy:

```bash
gcloud run services proxy cortex-permify \
  --region=us-central1 --project=cortex-drive-496915 --port=3476
```

**What it does:**

The proxy creates a local TCP listener (e.g. `http://localhost:3476`) and forwards
every request to the Cloud Run service's HTTPS URL. Before forwarding, it automatically
fetches an OIDC identity token from your local `gcloud` session and injects it as an
`Authorization: Bearer <token>` header. The Cloud Run service sees a valid OIDC token
and accepts the request as authenticated.

**What identity does it authenticate as?**

The token is issued for **your personal Google account** — the one you authenticated
with when you ran `gcloud auth login`. This account (your email) must have been granted
`roles/run.invoker` on the project (or on the specific service) in Cloud IAM. That one
role is what lets a principal call a Cloud Run service that requires OIDC auth. You can
verify it:

```bash
# See who currently has run.invoker on the project:
gcloud projects get-iam-policy cortex-drive-496915 \
  --flatten="bindings[].members" \
  --filter="bindings.role=roles/run.invoker" \
  --format="table(bindings.members)"

# See your active gcloud identity (the email the token is issued for):
gcloud config get account
```

**Two identities that must not be confused:**

| Identity | What it is | What it does |
|---|---|---|
| Your Google account (e.g. `sangeethavijayl@gmail.com`) | The human operator authenticated via `gcloud auth login` | What `gcloud run services proxy` authenticates AS when calling Cloud Run. Must have `roles/run.invoker`. |
| Compute Engine default SA (`377406326936-compute@developer.gserviceaccount.com`) | The service account that Cloud Run containers RUN AS at runtime | What the containers themselves use to access Secret Manager, Cloud SQL, etc. This SA also needs `roles/run.invoker` to call other internal Cloud Run services (e.g. gateway → mcp). |

The proxy bridges the first identity into an HTTP call that Cloud Run accepts. Inside
the container, the second identity takes over for any outbound calls the service makes.

**Why the proxy, not a direct call?**

Calling `https://cortex-permify-isabiovosq-uc.a.run.app` directly from your laptop
requires you to fetch and attach an OIDC token yourself. The proxy eliminates that step:
it handles token fetch, refresh, and header injection transparently, so scripts can use
plain `http://localhost:PORT` without any auth code.

---

## Cloud Run Logs

### Via Google Cloud Console

1. Go to [Cloud Console → Cloud Run](https://console.cloud.google.com/run?project=cortex-drive-496915)
2. Click the service name (e.g. `cortex-gateway`)
3. Click the **Logs** tab
4. Use the severity filter (All, Error, Warning) and time range picker at the top
5. Click any log line to expand the full structured payload

Alternatively via Log Explorer:
1. Go to [Cloud Console → Logging → Log Explorer](https://console.cloud.google.com/logs?project=cortex-drive-496915)
2. Paste a filter from the CLI section below into the query box
3. Click **Run Query**

---

### Via CLI

**Session setup (run once):**
```bash
source scripts/cloud-env.sh
# or set manually:
export PROJECT_ID=cortex-drive-496915
```

---

#### Recent logs — one-shot read

```bash
# Gateway (most useful for debugging auth, FGA, orchestration)
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="cortex-gateway"' \
  --project=cortex-drive-496915 --limit=50 \
  --format="table(timestamp,textPayload)"

# MCP SSE server
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="cortex-mcp"' \
  --project=cortex-drive-496915 --limit=50 \
  --format="table(timestamp,textPayload)"

# Bento HTTP server
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="cortex-bento"' \
  --project=cortex-drive-496915 --limit=50 \
  --format="table(timestamp,textPayload)"

# OpenFGA
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="cortex-openfga"' \
  --project=cortex-drive-496915 --limit=50 \
  --format="table(timestamp,textPayload)"

# Frontend (rarely needed — Next.js SSR errors)
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="cortex-ui"' \
  --project=cortex-drive-496915 --limit=50 \
  --format="table(timestamp,textPayload)"
```

---

#### Streaming logs — tail equivalent

```bash
# Stream gateway logs live (Ctrl+C to stop)
gcloud beta logging tail \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="cortex-gateway"' \
  --project=cortex-drive-496915

# Stream MCP logs live
gcloud beta logging tail \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="cortex-mcp"' \
  --project=cortex-drive-496915
```

---

#### Filtered logs — specific signal lines

```bash
# Auth + FGA + grounding signals only (first thing to check after a login)
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="cortex-gateway"
   AND textPayload=~"\[FGA\]|\[AUTH\]|\[GROUNDING\]"' \
  --project=cortex-drive-496915 --limit=30 \
  --format="table(timestamp,textPayload)"

# Errors only (all services)
gcloud logging read \
  'resource.type="cloud_run_revision" AND severity>=ERROR' \
  --project=cortex-drive-496915 --limit=30 \
  --format="table(timestamp,textPayload,resource.labels.service_name)"

# Errors on gateway only
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="cortex-gateway"
   AND severity>=ERROR' \
  --project=cortex-drive-496915 --limit=20 \
  --format="table(timestamp,textPayload)"

# GROUNDING violations only (hallucinated URLs stripped by auditResponseUrls)
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="cortex-gateway"
   AND textPayload=~"\[GROUNDING\]"' \
  --project=cortex-drive-496915 --limit=20 \
  --format="table(timestamp,textPayload)"

# MCP tool call failures (silent catch now logs these)
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="cortex-gateway"
   AND textPayload=~"Tool call failed"' \
  --project=cortex-drive-496915 --limit=20 \
  --format="table(timestamp,textPayload)"

# Permify read path — verify how many nodes a user can see (post-2026-07-08 migration)
# [PERMIFY] replaces the old [FGA] prefix after getAllowedNodeIds was switched to Permify
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="cortex-gateway"
   AND textPayload=~"\[PERMIFY\]"' \
  --project=cortex-drive-496915 --limit=20 --freshness=5m \
  --format="table(timestamp,textPayload)"

# Permify cache hits/misses — permission resolution from Redis vs. live Permify call
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="cortex-gateway"
   AND textPayload=~"\[PERM-CACHE\]"' \
  --project=cortex-drive-496915 --limit=20 --freshness=5m \
  --format="table(timestamp,textPayload)"

# Auth + Permify + grounding signals (post-migration equivalent of the old FGA filter)
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="cortex-gateway"
   AND textPayload=~"\[PERMIFY\]|\[AUTH\]|\[GROUNDING\]|\[PERM-CACHE\]"' \
  --project=cortex-drive-496915 --limit=30 --freshness=10m \
  --format="table(timestamp,textPayload)"
```

---

#### What to look for after first production login

Run the Auth + Permify + grounding filter above and confirm these lines appear:

| Expected log line | What it confirms |
|---|---|
| `[AUTH] Resolved Tenant ID: org_3E0FtIXiFM6DHwXg05sEVvq2mi0 (EnvOverride: true, ...)` | Secret Manager TENANT_ID override is active |
| `[PERMIFY] user:user_... can_view 341 nodes` | Permify returning full node list for owner (replaces old `[FGA]` line — switched 2026-07-08) |
| `[PERM-CACHE] miss — resolved 341 ids for user=..., cached 300s` | Permission cache populated from Permify; subsequent queries hit Redis |

If `EnvOverride: false` → TENANT_ID secret is missing or not mounted in Cloud Run.
If `[PERMIFY] can_view 0 nodes` → Permify unreachable, or ownership tuples missing (check `migrate_openfga_to_permify.py` was run).
If invited user sees `can_view 0 nodes` → their `shared_viewer` tuple is missing; revoke and re-share from the Sharing settings page.

---

## Cloud Run Service Management

```bash
# List all services and their URLs
gcloud run services list --region=us-central1 --project=cortex-drive-496915

# Describe a service (URLs, revision, env vars, secrets)
gcloud run services describe cortex-gateway --region=us-central1 --project=cortex-drive-496915

# List revisions for a service
gcloud run revisions list --service=cortex-gateway --region=us-central1 --project=cortex-drive-496915

# Get the live URL of a service
gcloud run services describe cortex-gateway \
  --region=us-central1 --project=cortex-drive-496915 \
  --format='value(status.url)'
```

---

## Cloud Run Build & Deploy

```bash
# One-time session setup
source scripts/cloud-env.sh

# Rebuild and redeploy each service
bash scripts/build-deploy-gateway.sh
bash scripts/build-deploy-mcp.sh
bash scripts/build-deploy-bento.sh
bash scripts/build-deploy-ui.sh

# OpenFGA has no build script — uses public image, deploy only
gcloud run deploy cortex-openfga \
  --image openfga/openfga:latest \
  --region us-central1 \
  --project cortex-drive-496915
```

Full per-service reference: `documents/cortex-drive-documents/cloud-run-build-deploy-runbook.md`

---

## Secret Manager

```bash
# List all secrets
gcloud secrets list --project=cortex-drive-496915

# Read any secret (latest version)
gcloud secrets versions access latest --secret=TENANT_ID --project=cortex-drive-496915
gcloud secrets versions access latest --secret=OWNER_USER_ID --project=cortex-drive-496915
gcloud secrets versions access latest --secret=CLERK_SECRET_KEY --project=cortex-drive-496915

# Read all 12 secrets at once
for S in OPENAI_API_KEY CLERK_SECRET_KEY NEO4J_URI NEO4J_USERNAME NEO4J_PASSWORD \
         TENANT_ID OWNER_USER_ID GATEWAY_SHARE_SECRET OPENFGA_DB_PASSWORD \
         OPENFGA_API_URL OPENFGA_STORE_ID OPENFGA_MODEL_ID; do
  echo "=== $S ===" && \
  gcloud secrets versions access latest --secret=$S --project=cortex-drive-496915
done

# Update a secret value
echo -n "new-value" | gcloud secrets versions add SECRET_NAME \
  --data-file=- --project=cortex-drive-496915
```

---

## Permify Infrastructure Deploy Checklist

All Permify code is committed. These are the remaining manual steps before the
Permify-based permission system is live in production. Steps within the same group
have no dependency on each other and can run in parallel.

| # | Step | Depends on | Status |
|---|---|---|---|
| 1 | Create `permify` database on `cortex-openfga-db` | — | ✅ Done 2026-06-30 |
| 2 | Create `cortexdrive_app` database on `cortex-openfga-db` | — | ✅ Done 2026-06-30 |
| 3 | Create `cortex-app-user`, store `CORTEX_APP_DB_PASSWORD` in Secret Manager | Step 2 | ✅ Done 2026-06-30 |
| 4 | Run `scripts/migrations/001_create_share_grants.sql` against `cortexdrive_app` | Step 3 | ✅ Done 2026-06-30 |
| 5 | Create `permify-user`, store `PERMIFY_DB_PASSWORD` in Secret Manager | Step 1 | ✅ Done 2026-06-30 |
| 6 | Deploy `cortex-permify` Cloud Run service (schema version `d9214gi9io6g00ak1qug`) | Step 5 | ✅ Done 2026-06-30 |
| 7 | Load Permify authorization schema (`scripts/openfga/authorization_schema.perm`) | Step 6 | ✅ Done 2026-06-30 |
| 8 | Store `PERMIFY_API_URL` secret in Secret Manager + grant compute SA access | Step 6 | ✅ Done 2026-06-30 |
| 9 | Add `PERMIFY_*` secrets to `cortex-mcp`, `cortex-bento`, `cortex-gateway` Cloud Run + rebuild | Steps 7, 8 | ✅ Done 2026-06-30 |
| 10 | Updated `build-deploy-gateway.sh` — `--add-cloudsql-instances` + DB secrets, redeployed | Steps 3, 8 | ✅ Done 2026-06-30 |
| 11 | Run `bootstrap_parent_tuples.py` (249 parent tuples + 27 `is_private` attrs) | Step 7 | ✅ Done 2026-06-30 |
| 12 | Write + run `migrate_openfga_to_permify.py` (migrate existing owner + tenant_viewer tuples) | Step 7 | ✅ Done 2026-07-01 |
| 13 | Run `scripts/migrations/002_create_groups.sql` — `groups` + `group_members` tables | Step 3 | ✅ Done 2026-07-06 |
| 14 | Run `scripts/migrations/003_add_grant_columns.sql` — `grant_type`, `subject_type`, `group_id` on `share_grants` | Step 13 | ✅ Done 2026-07-06 |
| 15 | Run `scripts/migrations/007_sharing_v2.sql` — sharing model v2 (roles, role_assignments, invitations; drop group_invitations + audience columns from share_grants) | Step 14 | ✅ Done 2026-07-08 |

---

### Step 3 — Create `cortex-app-user` and store password

```bash
CORTEX_APP_DB_PASSWORD=$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 32)
echo "Password: $CORTEX_APP_DB_PASSWORD"   # save before closing terminal

gcloud sql users create cortex-app-user \
  --instance=cortex-openfga-db \
  --password="$CORTEX_APP_DB_PASSWORD" \
  --project=cortex-drive-496915

echo -n "$CORTEX_APP_DB_PASSWORD" | gcloud secrets create CORTEX_APP_DB_PASSWORD \
  --data-file=- --replication-policy="automatic" --project=cortex-drive-496915

gcloud secrets add-iam-policy-binding CORTEX_APP_DB_PASSWORD \
  --member="serviceAccount:377406326936-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor" \
  --project=cortex-drive-496915
```

**Why `--data-file=-` with a trailing hyphen?**

The trailing `-` is a standard terminal convention that tells the command to read from
standard input (stdin) instead of looking for a physical file on disk. Here is how the
pipeline works:

1. `echo -n "..."` prints the password string into the terminal stream. The `-n` flag
   ensures no accidental hidden newline character is appended to the end of the password.
2. The pipe `|` catches that password string and passes it forward to the next command.
3. `--data-file=-` tells `gcloud`: *"Instead of opening a file like
   `--data-file=password.txt`, read the data being piped into you right now."*

This lets you upload the secret value securely in a single line without creating,
leaving behind, or having to clean up a temporary plaintext file on your disk.

### Step 4 — Run share_grants DDL migration

```bash
gcloud sql connect cortex-openfga-db \
  --user=cortex-app-user --database=cortexdrive_app \
  --project=cortex-drive-496915
# At psql prompt:
# \i scripts/migrations/001_create_share_grants.sql
```

---

### How to run any future SQL migration (preferred method — 2026-07-08)

`gcloud sql connect` requires an interactive terminal. For scripted or file-based
migrations, use Cloud SQL Auth Proxy + `psql` with the password fetched inline from
Secret Manager. This avoids storing credentials in the shell or any file.

**One-time setup — `psql` on Mac:**
```bash
# libpq is installed by Homebrew but keg-only (not linked to PATH by default)
# Add it permanently:
echo 'export PATH="/opt/homebrew/opt/libpq/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc

# Or install if not present:
brew install libpq
```

**Start Cloud SQL Auth Proxy (in background):**
```bash
cloud-sql-proxy cortex-drive-496915:us-central1:cortex-openfga-db &
# Listens on 127.0.0.1:5432
```

**Run a migration file:**
```bash
psql "host=127.0.0.1 port=5432 dbname=cortexdrive_app user=cortex-app-user \
  password=$(gcloud secrets versions access latest \
    --secret=CORTEX_APP_DB_PASSWORD --project=cortex-drive-496915)" \
  -f scripts/migrations/<migration_file>.sql
```

**Run an ad-hoc query (e.g. inspect table state):**
```bash
psql "host=127.0.0.1 port=5432 dbname=cortexdrive_app user=cortex-app-user \
  password=$(gcloud secrets versions access latest \
    --secret=CORTEX_APP_DB_PASSWORD --project=cortex-drive-496915)" \
  -c "SELECT invited_email, status FROM invitations ORDER BY invited_at DESC LIMIT 10;"
```

**Key facts:**
- DB instance: `cortex-drive-496915:us-central1:cortex-openfga-db`
- App database: `cortexdrive_app`
- App user: `cortex-app-user` (confirmed from `DB_USER` env var on `cortex-gateway` Cloud Run)
- Password secret: `CORTEX_APP_DB_PASSWORD` in Secret Manager
- Stop proxy when done: `kill %1` (or `pkill cloud-sql-proxy`)

### Step 5 — Create `permify-user` and store password

```bash
PERMIFY_DB_PASSWORD=$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 32)
echo "Password: $PERMIFY_DB_PASSWORD"   # save before closing terminal

gcloud sql users create permify-user \
  --instance=cortex-openfga-db \
  --password="$PERMIFY_DB_PASSWORD" \
  --project=cortex-drive-496915

echo -n "$PERMIFY_DB_PASSWORD" | gcloud secrets create PERMIFY_DB_PASSWORD \
  --data-file=- --replication-policy="automatic" --project=cortex-drive-496915

gcloud secrets add-iam-policy-binding PERMIFY_DB_PASSWORD \
  --member="serviceAccount:377406326936-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor" \
  --project=cortex-drive-496915
```

### Step 6 — Deploy `cortex-permify` Cloud Run service

Mirror VPC egress and service account from `cortex-openfga`. Fetch `PERMIFY_DB_PASSWORD`
from Secret Manager first:

```bash
PERMIFY_DB_PASSWORD=$(gcloud secrets versions access latest \
  --secret=PERMIFY_DB_PASSWORD --project=cortex-drive-496915)

CLOUD_SQL_CONN="cortex-drive-496915:us-central1:cortex-openfga-db"
PERMIFY_DB_URI="postgresql://permify-user:${PERMIFY_DB_PASSWORD}@/permify?host=/cloudsql/${CLOUD_SQL_CONN}"

gcloud run deploy cortex-permify \
  --image ghcr.io/permify/permify:latest \
  --region us-central1 \
  --project cortex-drive-496915 \
  --no-allow-unauthenticated \
  --port 3476 \
  --memory 512Mi \
  --min-instances 0 \
  --max-instances 2 \
  --add-cloudsql-instances "$CLOUD_SQL_CONN" \
  --set-env-vars "PERMIFY_DATABASE_URI=${PERMIFY_DB_URI}"

# Save the URL — needed for Steps 7, 8, 9
PERMIFY_API_URL=$(gcloud run services describe cortex-permify \
  --region us-central1 --project cortex-drive-496915 --format='value(status.url)')
echo "Permify URL: $PERMIFY_API_URL"
```

### Step 7 — Load Permify authorization schema

The schema endpoint requires JSON `{"schema": "<DSL string>"}`, not a raw `.perm` file.
Use Python to wrap the file contents, then POST via the Cloud Run proxy (proxy handles
OIDC auth automatically — no token management needed):

```bash
# Terminal 1: start proxy (leave running for the duration)
gcloud run services proxy cortex-permify \
  --region=us-central1 --project=cortex-drive-496915 --port=3476

# Terminal 2: load the schema (JSON-wrap the DSL file first)
PAYLOAD=$(python3 -c \
  "import json; print(json.dumps({'schema': open('scripts/openfga/authorization_schema.perm').read()}))")

curl -s -X POST http://localhost:3476/v1/tenants/cortex-drive/schemas/write \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD"
# Expected response: {"schema_version":"<version-id>"}

# Verify — schema/read also requires POST with empty body, not GET
curl -s -X POST http://localhost:3476/v1/tenants/cortex-drive/schemas/read \
  -H "Content-Type: application/json" -d '{}' | python3 -m json.tool
```

**Known DSL restrictions** (hit during 2026-06-30 deployment):
- Multi-line permission expressions are not supported — keep each permission on one line.
- `not` as a prefix operator to a rule call is not supported — invert the rule logic
  instead (e.g. rename `check_private { is_private == true }` to
  `check_not_private { is_private != true }` and drop the `not` from the permission).

**Permify PostgreSQL persistence requires `PERMIFY_DATABASE_ENGINE=postgres` to be set
on the Cloud Run service** alongside `PERMIFY_DATABASE_URI`. Without it, Permify silently
defaults to in-memory storage — schema and data writes succeed but are lost on restart.
Add it once per service:

```bash
gcloud run services update cortex-permify \
  --region=us-central1 --project=cortex-drive-496915 \
  --update-env-vars "PERMIFY_DATABASE_ENGINE=postgres"
```

Active schema version (PostgreSQL-persisted, 2026-06-30): **`d922hd29io6g008ivglg`**
Update `PERMIFY_SCHEMA_VERSION` in `scripts/cloud-env.sh` and `.env` whenever the
schema is reloaded.

### Step 8 — Store `PERMIFY_API_URL` in Secret Manager

```bash
PERMIFY_API_URL=$(gcloud run services describe cortex-permify \
  --region us-central1 --project cortex-drive-496915 --format='value(status.url)')

echo -n "$PERMIFY_API_URL" | gcloud secrets create PERMIFY_API_URL \
  --data-file=- --replication-policy="automatic" --project=cortex-drive-496915

for SECRET in PERMIFY_API_URL PERMIFY_DB_PASSWORD; do
  gcloud secrets add-iam-policy-binding $SECRET \
    --member="serviceAccount:377406326936-compute@developer.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor" \
    --project=cortex-drive-496915
done
```

### Step 9 — Add `PERMIFY_*` env vars to `cortex-mcp`, `cortex-bento`, `cortex-gateway`

`PERMIFY_TENANT_ID` and `PERMIFY_MAX_DEPTH` are plain env vars; `PERMIFY_API_URL` is a
secret. All three are wired into the build-deploy scripts (not via ad-hoc `gcloud run
services update`) so that a full rebuild always produces a consistent revision:

- `scripts/build-deploy-mcp.sh` — `--set-env-vars "PERMIFY_TENANT_ID=...,PERMIFY_MAX_DEPTH=5"` + `--set-secrets "...,PERMIFY_API_URL=PERMIFY_API_URL:latest"`
- `scripts/build-deploy-bento.sh` — same
- `scripts/build-deploy-gateway.sh` — same, plus `PERMIFY_API_URL` is a secret alongside the DB secrets

To apply: run the respective build-deploy script. Use `--update-secrets` only for a
quick patch without a full image rebuild:

```bash
for SERVICE in cortex-mcp cortex-bento cortex-gateway; do
  gcloud run services update $SERVICE \
    --region us-central1 --project cortex-drive-496915 \
    --update-env-vars "PERMIFY_TENANT_ID=cortex-drive,PERMIFY_MAX_DEPTH=5" \
    --update-secrets "PERMIFY_API_URL=PERMIFY_API_URL:latest"
done
```

### Step 10 — Update `build-deploy-gateway.sh` to add Cloud SQL + DB secrets, then redeploy

`build-deploy-gateway.sh` currently has no `--add-cloudsql-instances` and no DB secrets.
The gateway now uses `cortex-gateway/utils/db.js` to connect to `cortexdrive_app` for
the `share_grants` table. Add to the `gcloud run deploy cortex-gateway` call:

```
--add-cloudsql-instances "cortex-drive-496915:us-central1:cortex-openfga-db" \
--update-env-vars "CLOUD_SQL_INSTANCE=cortex-drive-496915:us-central1:cortex-openfga-db,DB_NAME=cortexdrive_app,DB_USER=cortex-app-user" \
--update-secrets "DB_PASSWORD=CORTEX_APP_DB_PASSWORD:latest"
```

Then redeploy:

```bash
source scripts/cloud-env.sh
bash scripts/build-deploy-gateway.sh
```

### Step 11 — Run `bootstrap_parent_tuples.py`

Writes 249 parent tuples and 27 `is_private=true` attributes into Permify for the
existing Neo4j graph. The script reads Neo4j directly (requires `NEO4J_URI`,
`NEO4J_USERNAME`, `NEO4J_PASSWORD` from `.env`) and calls Permify via HTTP.

`cortex-permify` requires OIDC auth (`--no-allow-unauthenticated`). Locally, use the
`gcloud run services proxy` — it transparently adds the Authorization header so no
`PERMIFY_API_TOKEN` env var is needed. Set `PERMIFY_API_URL=http://localhost:3476`
to route the script through the proxy.

**Prerequisites:** Neo4j Aura instance must be online (check console.neo4j.io if DNS
fails — free-tier instances auto-pause after 72 h of inactivity).

```bash
# From project root
source scripts/cloud-env.sh   # sets PROJECT_ID, REGION

# Step 1: start Permify proxy in the background
gcloud run services proxy cortex-permify \
  --region=us-central1 --project=cortex-drive-496915 --port=3476 &
PROXY_PID=$!
sleep 5   # wait for proxy to be ready

# Step 2: dry-run — confirms Neo4j connectivity and expected write counts (no Permify writes)
PERMIFY_API_URL=http://localhost:3476 \
  .venv/bin/python scripts/bootstrap_parent_tuples.py --dry-run
# Expected output:
#   [bootstrap] Found 249 composition edges.
#   [bootstrap] Found 27 PreparatoryNote nodes.
#   [bootstrap] Dry-run complete — no writes made.

# Step 3: live write (only run after dry-run counts look correct)
PERMIFY_API_URL=http://localhost:3476 \
  .venv/bin/python scripts/bootstrap_parent_tuples.py

# Step 4: stop the proxy
kill $PROXY_PID
```

**Verify writes:**
```bash
# Start proxy again if closed
gcloud run services proxy cortex-permify \
  --region=us-central1 --project=cortex-drive-496915 --port=3476 &
PROXY_PID=$!
sleep 5

# Check relationship count
curl -s -X POST http://localhost:3476/v1/tenants/cortex-drive/relationships/read \
  -H "Content-Type: application/json" \
  -d '{"metadata": {"snap_token": "", "depth": 0}, "filter": {"entity": {"type": "node", "id": ""}, "relation": "parent", "subject": {"type": "node", "id": "", "relation": ""}}}' \
  | python3 -m json.tool | grep -c '"id"'

kill $PROXY_PID
```

**Status:** ✅ Completed 2026-06-30 (initial) + re-run 2026-07-01 (after API fix).
Active schema version: `d922hd29io6g008ivglg`.

**Note:** The Step 11 bootstrap was re-run on 2026-07-01 because the parent tuple
writes on 2026-06-30 used `POST /data/write` with `"relationships"` key, which silently
no-ops in Permify v0.9+ (see Step 12 issues). The `is_private` attribute writes (which
correctly use `/data/write` with `"attributes"` key) were already correct. After fixing
`permify_utils.py` (Step 12), bootstrap was re-run to populate parent tuples properly.

**Issues encountered during Step 11 (for future reference):**
- `/data` endpoint → 404 in this Permify version; correct path is `/data/write`
- Payload field `"tuples"` → renamed to `"relationships"` in this Permify version (for attribute writes)
- `schema_version: ""` always rejected — exact version hash required; store in `PERMIFY_SCHEMA_VERSION`
- `PERMIFY_DATABASE_ENGINE=postgres` was missing → Permify defaulted to in-memory, schema lost on restart; added via `gcloud run services update`

### Step 12 — Run `migrate_openfga_to_permify.py` ✅ Done 2026-07-01

Migrates 682 OpenFGA tuples (341 owner + 341 tenant_viewer) + 1 derived `org#member`
tuple into Permify. Idempotent — safe to re-run.

```bash
# Both proxies must be running simultaneously:
gcloud run services proxy cortex-openfga \
  --region=us-central1 --project=cortex-drive-496915 --port=8082 &
gcloud run services proxy cortex-permify \
  --region=us-central1 --project=cortex-drive-496915 --port=3476 &
sleep 6

# Get live store ID from Secret Manager (NOT from .env — .env has stale value):
LIVE_STORE_ID=$(gcloud secrets versions access latest \
  --secret=OPENFGA_STORE_ID --project=cortex-drive-496915)

source scripts/cloud-env.sh
set -a; source .env; set +a

# Dry-run first:
OPENFGA_API_URL=http://localhost:8082 \
OPENFGA_STORE_ID="$LIVE_STORE_ID" \
PERMIFY_API_URL=http://localhost:3476 \
PERMIFY_TENANT_ID=cortex-drive \
PERMIFY_SCHEMA_VERSION=${PERMIFY_SCHEMA_VERSION} \
.venv/bin/python scripts/migrate_openfga_to_permify.py --dry-run

# Run for real:
OPENFGA_API_URL=http://localhost:8082 \
OPENFGA_STORE_ID="$LIVE_STORE_ID" \
PERMIFY_API_URL=http://localhost:3476 \
PERMIFY_TENANT_ID=cortex-drive \
PERMIFY_SCHEMA_VERSION=${PERMIFY_SCHEMA_VERSION} \
.venv/bin/python scripts/migrate_openfga_to_permify.py
```

**Smoke test after migration:**
```bash
OWNER_NODE="bdc213a0-c0bf-467a-ad7f-40023eaba7e2"
OWNER_USER="user_3E07ZZZL4kDTo2vzAgpC1erDxjF"

# Expect CHECK_RESULT_ALLOWED:
curl -s -X POST http://localhost:3476/v1/tenants/cortex-drive/permissions/check \
  -H 'Content-Type: application/json' \
  --data-raw "{\"metadata\":{\"depth\":5,\"schema_version\":\"\",\"snap_token\":\"\"},
    \"entity\":{\"type\":\"node\",\"id\":\"$OWNER_NODE\"},
    \"permission\":\"can_view\",
    \"subject\":{\"type\":\"user\",\"id\":\"$OWNER_USER\"},
    \"context\":{\"tuples\":[],\"attributes\":[],\"data\":{}}}"

# Expect 342+ visible nodes:
curl -s -X POST http://localhost:3476/v1/tenants/cortex-drive/permissions/lookup-entity \
  -H 'Content-Type: application/json' \
  --data-raw "{\"metadata\":{\"depth\":5,\"schema_version\":\"\",\"snap_token\":\"\"},
    \"entity_type\":\"node\",\"permission\":\"can_view\",
    \"subject\":{\"type\":\"user\",\"id\":\"$OWNER_USER\"},
    \"context\":{\"tuples\":[],\"attributes\":[],\"data\":{}}}" | python3 -c \
  "import sys,json; d=json.load(sys.stdin); print('count:', len(d.get('entity_ids',[])))"
```

**Issues encountered and resolved (2026-07-01):**
- Permify v0.9+ breaking API change: `POST /data/write` with `"relationships"` key silently
  no-ops for relationships (returns snap_token but stores nothing). Correct endpoint is
  `POST /relationships/write` with `"tuples"` key. Fixed in `permify_utils.py`.
- `LookupEntity` response key is `entity_ids` (snake_case), not `entityIds` (camelCase).
  Fixed in `permify_utils.py` `list_viewable_node_ids()`.
- `bootstrap_parent_tuples.py` must also be re-run after the API fix (Step 11 parent
  tuples were written to the wrong endpoint and never stored). Re-ran 2026-07-01.

### Steps 13 + 14 — Run group sharing migrations ✅ Done 2026-07-06

**Why these migrations are needed:**
The graph island sharing feature (Share Graph button + custom group sharing) requires two
new tables and three new columns that did not exist in the initial `share_grants` DDL:

- `groups` — named audience sets (hr-recruiters, hiring-managers, etc.). Cross-org:
  members can belong to different companies. Group management is inside CortexDrive
  for now (SCIM sync deferred).
- `group_members` — (group_id, user_sub) with `user_org_id` for compliance tracking.
  `ON DELETE CASCADE` from groups. Permify group tuple written on member add/remove.
- `share_grants.grant_type` — `'node'` (existing single-root share) or `'graph_island'`
  (all N visible canvas nodes shared in one operation). Revocation behavior differs:
  graph_island revoke fans out across all `child_node_ids`, not just `root_node_id`.
- `share_grants.subject_type` — `'user'` or `'group'`.
- `share_grants.group_id` — FK to `groups`; populated for group shares.

**Must run in order** — `003` has a FK on `group_id` referencing the `groups` table
created by `002`.

**How to run (Cloud SQL Auth Proxy approach):**

`gcloud sql connect` works but requires the proxy binary to be available separately.
The explicit approach below works even if `gcloud sql connect` can't find `psql` in PATH:

```bash
# Terminal A — start proxy, keep it running
cloud-sql-proxy cortex-drive-496915:us-central1:cortex-openfga-db --port=5433

# Terminal B — fetch password and run migrations
PGPASSWORD=$(gcloud secrets versions access latest \
  --secret=CORTEX_APP_DB_PASSWORD --project=cortex-drive-496915)

PSQL=/opt/homebrew/opt/libpq/bin/psql
REPO=<path-to-cortex-drive-repo>

# Verify connection
$PSQL -h 127.0.0.1 -p 5433 -U cortex-app-user -d cortexdrive_app -c "\dt"

# Run in order — 002 must complete before 003
$PSQL -h 127.0.0.1 -p 5433 -U cortex-app-user -d cortexdrive_app \
  -f $REPO/scripts/migrations/002_create_groups.sql

$PSQL -h 127.0.0.1 -p 5433 -U cortex-app-user -d cortexdrive_app \
  -f $REPO/scripts/migrations/003_add_grant_columns.sql

# Verify
$PSQL -h 127.0.0.1 -p 5433 -U cortex-app-user -d cortexdrive_app \
  -c "\dt" \
  -c "\d share_grants"
```

**Expected output from verification:**
- `\dt` lists 3 tables: `group_members`, `groups`, `share_grants`
- `\d share_grants` shows columns `grant_type`, `subject_type`, `group_id` with CHECK
  constraints and FK to `groups`

**All three migrations are idempotent** (`CREATE TABLE IF NOT EXISTS`,
`ADD COLUMN IF NOT EXISTS`) — safe to re-run if interrupted.

---

## Cloud SQL (OpenFGA Postgres)

```bash
# Describe instance
gcloud sql instances describe cortex-openfga-db --project=cortex-drive-496915

# Connect and inspect OpenFGA tables
gcloud sql connect cortex-openfga-db \
  --user=openfga-user --database=openfga \
  --project=cortex-drive-496915

# Inside psql:
# \dt                              — list tables
# SELECT COUNT(*) FROM tuple;      — count authorization tuples (expect 682 after bootstrap)
# SELECT store_id, COUNT(*) FROM tuple GROUP BY store_id;
```

---

## Cloud SQL — Adding a New Database (Pattern)

The instance `cortex-openfga-db` hosts multiple databases. Each database gets its own
dedicated user. No `postgres` superuser login is needed — `gcloud sql databases create`
and `gcloud sql users create` are admin-plane commands (IAM-gated, no DB password required).
Users created via gcloud are granted `cloudsqlsuperuser` role automatically and can CREATE
TABLE without further grants.

**How the Cloud SQL instance + `openfga` database + `openfga-user` were originally created (Phase 6.5 of `scripts/deploy-gcp.sh`, executed 2026-06-05):**

```bash
# 1. Create the Cloud SQL instance (one-time — already exists, do not re-run)
gcloud sql instances create cortex-openfga-db \
  --database-version=POSTGRES_15 \
  --tier=db-f1-micro \
  --region=us-central1 \
  --project=cortex-drive-496915
# Takes ~5 min to provision.

# 2. Create the openfga database inside the instance
gcloud sql databases create openfga \
  --instance=cortex-openfga-db --project=cortex-drive-496915

# 3. Generate a password and create a dedicated user
OPENFGA_DB_PASSWORD=$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 32)

gcloud sql users create openfga-user \
  --instance=cortex-openfga-db \
  --password="$OPENFGA_DB_PASSWORD" \
  --project=cortex-drive-496915

# 4. Store in Secret Manager
echo -n "$OPENFGA_DB_PASSWORD" | gcloud secrets create OPENFGA_DB_PASSWORD \
  --data-file=- --replication-policy="automatic" --project=cortex-drive-496915
```

The Cloud SQL connector name and DB URI used by `cortex-openfga` Cloud Run service:

```bash
CLOUD_SQL_CONN="cortex-drive-496915:us-central1:cortex-openfga-db"
OPENFGA_DB_URI="postgresql://openfga-user:${OPENFGA_DB_PASSWORD}@/openfga?host=/cloudsql/${CLOUD_SQL_CONN}"
```

These are passed to `gcloud run deploy cortex-openfga` via:
- `--add-cloudsql-instances "$CLOUD_SQL_CONN"`
- `--set-env-vars "OPENFGA_DATASTORE_ENGINE=postgres,OPENFGA_DATASTORE_URI=${OPENFGA_DB_URI}"`

The compute SA also requires `roles/cloudsql.client` to use the Cloud SQL proxy sidecar:

```bash
gcloud projects add-iam-policy-binding cortex-drive-496915 \
  --member="serviceAccount:377406326936-compute@developer.gserviceaccount.com" \
  --role="roles/cloudsql.client"
```

**How `cortexdrive_app` + `cortex-app-user` were created (2026-06-30):**

Same pattern. `cortexdrive_app` is the application database for the `share_grants` table
(Permify rollout). `permify` database on the same instance holds Permify's tuple store.

```bash
# Step 1: Create the database
gcloud sql databases create cortexdrive_app \
  --instance=cortex-openfga-db --project=cortex-drive-496915

# Step 2: Generate a password and create a dedicated user
CORTEX_APP_DB_PASSWORD=$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 32)
echo "Password: $CORTEX_APP_DB_PASSWORD"   # save before closing the terminal

gcloud sql users create cortex-app-user \
  --instance=cortex-openfga-db \
  --password="$CORTEX_APP_DB_PASSWORD" \
  --project=cortex-drive-496915

# Step 3: Store in Secret Manager + grant compute SA access
echo -n "$CORTEX_APP_DB_PASSWORD" | gcloud secrets create CORTEX_APP_DB_PASSWORD \
  --data-file=- --replication-policy="automatic" --project=cortex-drive-496915

gcloud secrets add-iam-policy-binding CORTEX_APP_DB_PASSWORD \
  --member="serviceAccount:377406326936-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor" \
  --project=cortex-drive-496915

# Step 4: Run the share_grants DDL migration
gcloud sql connect cortex-openfga-db \
  --user=cortex-app-user --database=cortexdrive_app \
  --project=cortex-drive-496915
# At the psql prompt, paste or \i scripts/migrations/001_create_share_grants.sql
```

**Gateway env vars for `cortex-gateway` Cloud Run service:**

```
DB_USER=cortex-app-user
DB_PASSWORD=<CORTEX_APP_DB_PASSWORD secret>
DB_NAME=cortexdrive_app
CLOUD_SQL_INSTANCE=cortex-drive-496915:us-central1:cortex-openfga-db
```

**Credential policy — one user per database, not one shared user:**

Each database on `cortex-openfga-db` gets its own dedicated Cloud SQL user. Never share
credentials across databases. Reasons:

| Concern | Shared user | Individual user per database |
|---|---|---|
| Blast radius | Compromised credential exposes all databases on the instance | Compromised credential exposes only one database |
| Rotation | Rotating requires updating all dependent services simultaneously | Each service rotates independently |
| Audit | All DB activity in Cloud SQL logs is indistinguishable | Activity is attributable to a specific service |
| Least privilege | `cortex-gateway` has no business reading OpenFGA tuples directly | Each service can only touch its own database |

**Current database inventory on `cortex-openfga-db`:**

| Database | Owner user | Secret | Purpose |
|---|---|---|---|
| `openfga` | `openfga-user` | `OPENFGA_DB_PASSWORD` | OpenFGA tuple store (legacy, being replaced by Permify) |
| `permify` | `permify-user` *(to be created — see below)* | `PERMIFY_DB_PASSWORD` | Permify tuple store |
| `cortexdrive_app` | `cortex-app-user` | `CORTEX_APP_DB_PASSWORD` | Application DB — `share_grants` table |

**Creating `permify-user` (required before deploying `cortex-permify` Cloud Run):**

```bash
PERMIFY_DB_PASSWORD=$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 32)

gcloud sql users create permify-user \
  --instance=cortex-openfga-db \
  --password="$PERMIFY_DB_PASSWORD" \
  --project=cortex-drive-496915

echo -n "$PERMIFY_DB_PASSWORD" | gcloud secrets create PERMIFY_DB_PASSWORD \
  --data-file=- --replication-policy="automatic" --project=cortex-drive-496915

gcloud secrets add-iam-policy-binding PERMIFY_DB_PASSWORD \
  --member="serviceAccount:377406326936-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor" \
  --project=cortex-drive-496915
```

The `PERMIFY_DATABASE_URI` env var for the `cortex-permify` Cloud Run service:

```
postgresql://permify-user:<PERMIFY_DB_PASSWORD>@/permify?host=/cloudsql/cortex-drive-496915:us-central1:cortex-openfga-db
```

---

## Health & Smoke Tests

```bash
# Gateway health check
curl https://api.cortex-drive.com/health
# Expected: {"status":"ok"}

# Auth gate (no JWT — must return 401)
curl -X POST https://api.cortex-drive.com/query \
  -H "Content-Type: application/json" \
  -d '{"question":"test","history":[]}'
# Expected: 401 Unauthorized

# Verify CORS restriction
curl -si -X OPTIONS https://api.cortex-drive.com/query \
  -H "Origin: https://app.cortex-drive.com" \
  -H "Access-Control-Request-Method: POST" \
  | grep access-control-allow-origin
# Expected: access-control-allow-origin: https://app.cortex-drive.com

# Q1/Q2/Q3 AP-12 smoke tests (requires Clerk JWT from browser DevTools)
JWT="<paste Bearer token from DevTools Network tab>"

curl -X POST https://api.cortex-drive.com/query \
  -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d '{"question":"Find episodes discussing graph databases","history":[]}'

curl -X POST https://api.cortex-drive.com/query \
  -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d '{"question":"Show career map of Sangeetha Ramadurai","history":[]}'

curl -X POST https://api.cortex-drive.com/query \
  -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d '{"question":"How did thought leadership influence Cortex-Drive?","history":[]}'
```

---

## GCS Video Hosting

```bash
# List videos in bucket
gsutil ls gs://cortex-drive-videos/

# Upload a new or replacement video
gsutil cp <local-file.mp4> gs://cortex-drive-videos/

# Verify a video is publicly accessible
curl -sI https://storage.googleapis.com/cortex-drive-videos/<filename>.mp4 | head -3
# Expected: HTTP/2 200  content-type: video/mp4
```

Videos referenced in: `cortex-chat-ui/app/page.tsx` (`GCS_VIDEOS` constant).
If a filename changes, update that constant and redeploy the UI.

---

## Reference Documents

| Document | Purpose |
|---|---|
| `documents/cortex-drive-documents/cloud-move-implementation-plan-2026-05-14.md` | Master migration plan (Phases 0–10) |
| `documents/cortex-drive-documents/cloud-run-build-deploy-runbook.md` | Per-service build/deploy with all workarounds |
| `documents/daily_logs/daily_log-2026-06-18.md` | Neo4j verification results + open cleanup items |
| `documents/daily_logs/daily_log-2026-06-18-cloud-deployment-progress.md` | Full deployment status summary |
| `documents/daily_logs/daily_log-2026-06-11.md` | Cloud NAT hardening steps (Q8) |
| `documents/architecture/cloud-run-network-security-architecture.md` | VPC / ingress security design |
