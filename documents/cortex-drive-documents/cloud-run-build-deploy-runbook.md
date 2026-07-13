# CortexDrive — Cloud Run Build & Deploy Runbook

**Status:** Active. Last significant update: 2026-07-10 — entity catalog section added; deployment verification commands; log inspection patterns; deploy order for synchronized MCP+gateway changes.

Reference for rebuilding or redeploying any individual service after code changes.

---

## Standard Workflow — Two Commands Per Service

```bash
# 1. From project root — once per terminal session
cd /path/to/cortex-drive
source scripts/cloud-env.sh

# 2. Build + deploy any service with a single script
bash scripts/build-deploy-gateway.sh
bash scripts/build-deploy-mcp.sh
bash scripts/build-deploy-bento.sh
bash scripts/build-deploy-ui.sh
```

Each script handles all context setup internally — you do not need to `cd` anywhere
or pass any arguments. Each script exits with an error if `cloud-env.sh` was not sourced.

For `cortex-openfga` there is no build script (it uses the public `openfga/openfga:latest`
image). See the openfga section below for the `gcloud run deploy` command.

### Why scripts are needed (context details)

| Service | Script build approach | Why not direct `gcloud builds submit .` from project root |
|---|---|---|
| `cortex-gateway` | Minimal `/tmp` context (gateway + prompts) | Full repo too large; Dockerfile needs `cortex-gateway/` + `prompts/` as siblings |
| `cortex-mcp` | Direct from `$REPO/src/mcp_server` | Small enough; Dockerfile is there |
| `cortex-bento` | Minimal `/tmp` context with `Dockerfile.bento` renamed to `Dockerfile` | `gcloud builds submit --tag` requires the file to be named exactly `Dockerfile` |
| `cortex-ui` | Minimal `/tmp` context + inline `cloudbuild.yaml` | `public/videos/` is hundreds of MB; `ARG` build-time vars need `cloudbuild.yaml` for `--build-arg` |
| `cortex-openfga` | No build — `gcloud run deploy` only | Uses public `openfga/openfga:latest` image |

`cloud-env.sh` exports: `PROJECT_ID`, `REGION`, `REGISTRY`, `REPO`, all service URLs,
custom domains, `CLOUD_SQL_CONN`, and `CLERK_PK`. See `scripts/cloud-env.sh` for full list.

---

## Live Service URLs

| Service | Custom Domain | Raw Cloud Run URL | Ingress |
|---|---|---|---|
| `cortex-ui` | `https://app.cortex-drive.com` | `https://cortex-ui-isabiovosq-uc.a.run.app` | public |
| `cortex-gateway` | `https://api.cortex-drive.com` | `https://cortex-gateway-isabiovosq-uc.a.run.app` | public |
| `cortex-mcp` | — | `https://cortex-mcp-isabiovosq-uc.a.run.app` | all (OIDC required) |
| `cortex-bento` | — | `https://cortex-bento-isabiovosq-uc.a.run.app` | internal |
| `cortex-openfga` | — | `https://cortex-openfga-isabiovosq-uc.a.run.app` | all (auth required) |
| `cortex-permify` | — | `https://cortex-permify-isabiovosq-uc.a.run.app` | all (OIDC required) |

Region: `us-central1` | Artifact Registry: `us-central1-docker.pkg.dev/cortex-drive-496915/cortex-images/`

---

## CORS Restriction — Where the Code Lives

**File:** `cortex-gateway/index.js` lines 457–460

```javascript
// ALLOWED_ORIGIN: restrict to app subdomain in production, wildcard in local dev.
// Set ALLOWED_ORIGIN=https://app.cortex-drive.com in Cloud Run env after custom domain is live.
const _corsOrigin = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: _corsOrigin }));
```

**How it works:**
- Local dev: `ALLOWED_ORIGIN` not set → `cors({ origin: '*' })` → all origins allowed
- Cloud Run production: `ALLOWED_ORIGIN=https://app.cortex-drive.com` is injected as an
  env var at deploy time → gateway only echoes `app.cortex-drive.com` in the
  `Access-Control-Allow-Origin` response header → browsers block requests from any other origin

**How to verify it's working:**
```bash
# Should return: access-control-allow-origin: https://app.cortex-drive.com
curl -si -X OPTIONS https://api.cortex-drive.com/query \
  -H "Origin: https://app.cortex-drive.com" \
  -H "Access-Control-Request-Method: POST" | grep access-control-allow-origin
```

---

## Build and Deploy — Per Service

> **Important:** `gcloud builds submit` gzips the source before upload. Submitting from the
> repo root fails due to a Python 3.13 gzip bug on large trees. Always build from a **minimal
> context directory** as shown below, or from the service's own subdirectory.

### Prerequisites (one-time)

```bash
gcloud auth login
gcloud auth configure-docker us-central1-docker.pkg.dev
gcloud config set project cortex-drive-496915
```

---

### 1. cortex-gateway

**Source:** `cortex-gateway/index.js`, `cortex-gateway/config/`, `cortex-gateway/utils/`,
`prompts/` (system prompt is at `../prompts` relative to `index.js`)

**Why minimal context:** The gateway Dockerfile expects `cortex-gateway/` and `prompts/`
as subdirectories of the context root — it cannot be built from `cortex-gateway/` directly.

```bash
REPO="/path/to/cortex-drive"
REGISTRY="us-central1-docker.pkg.dev/cortex-drive-496915/cortex-images"

# 1. Build minimal context
BCTX="/tmp/cortex-gateway-ctx"
rm -rf "$BCTX" && mkdir -p "$BCTX/cortex-gateway/config" "$BCTX/cortex-gateway/utils" "$BCTX/prompts"
cp "$REPO/cortex-gateway/Dockerfile"        "$BCTX/"
cp "$REPO/cortex-gateway/package.json"      "$BCTX/cortex-gateway/"
cp "$REPO/cortex-gateway/package-lock.json" "$BCTX/cortex-gateway/"
cp "$REPO/cortex-gateway/index.js"          "$BCTX/cortex-gateway/"
cp "$REPO/cortex-gateway/config/"*          "$BCTX/cortex-gateway/config/"
cp "$REPO/cortex-gateway/utils/"*           "$BCTX/cortex-gateway/utils/"
cp "$REPO/prompts/"*                        "$BCTX/prompts/"

# 2. Build and push
cd "$BCTX"
gcloud builds submit --tag "${REGISTRY}/cortex-gateway:latest" --project=cortex-drive-496915 .

# 3. Deploy
MCP_URL="https://cortex-mcp-isabiovosq-uc.a.run.app"
BENTO_URL="https://cortex-bento-isabiovosq-uc.a.run.app"

CLOUD_SQL_CONN="cortex-drive-496915:us-central1:cortex-openfga-db"

gcloud run deploy cortex-gateway \
    --image "${REGISTRY}/cortex-gateway:latest" \
    --region us-central1 --project cortex-drive-496915 \
    --allow-unauthenticated \
    --port 8080 --memory 512Mi --timeout 600 \
    --min-instances 0 --max-instances 5 \
    --add-cloudsql-instances "${CLOUD_SQL_CONN}" \
    --set-env-vars "MCP_SERVER_URL=${MCP_URL},BENTO_SERVER_URL=${BENTO_URL},\
NODE_ENV=production,ALLOWED_ORIGIN=https://app.cortex-drive.com,\
CLOUD_SQL_INSTANCE=${CLOUD_SQL_CONN},DB_NAME=cortexdrive_app,\
DB_USER=cortex-app-user,\
PERMIFY_TENANT_ID=cortex-drive,PERMIFY_MAX_DEPTH=5,\
PERMIFY_SCHEMA_VERSION=d922hd29io6g008ivglg" \
    --set-secrets "OPENAI_API_KEY=OPENAI_API_KEY:latest,\
CLERK_SECRET_KEY=CLERK_SECRET_KEY:latest,\
TENANT_ID=TENANT_ID:latest,OWNER_USER_ID=OWNER_USER_ID:latest,\
GATEWAY_SHARE_SECRET=GATEWAY_SHARE_SECRET:latest,\
OPENFGA_API_URL=OPENFGA_API_URL:latest,\
OPENFGA_STORE_ID=OPENFGA_STORE_ID:latest,\
OPENFGA_MODEL_ID=OPENFGA_MODEL_ID:latest,\
PERMIFY_API_URL=PERMIFY_API_URL:latest,\
REDIS_URL=REDIS_URL:latest,\
DB_PASSWORD=CORTEX_APP_DB_PASSWORD:latest,\
CLERK_WEBHOOK_SECRET=CLERK_WEBHOOK_SECRET:latest,\
RESEND_API_KEY=RESEND_API_KEY:latest"

# Cloud SQL note: the gateway connects via Unix socket at /cloudsql/<CLOUD_SQL_CONN>
# (created by --add-cloudsql-instances). Do NOT use @google-cloud/cloud-sql-connector
# with ipType:'PRIVATE' — the instance has no private IP. See db.js for connection logic.
```

---

### 2. cortex-mcp (MCP SSE Server)

**Source:** `src/mcp_server/` — build directly from that directory, `Dockerfile` is named
`Dockerfile` (not `Dockerfile.bento`).

```bash
REGISTRY="us-central1-docker.pkg.dev/cortex-drive-496915/cortex-images"

# 1. Build (context = src/mcp_server/)
cd /path/to/cortex-drive/src/mcp_server
gcloud builds submit --tag "${REGISTRY}/cortex-mcp:latest" --project=cortex-drive-496915 .

# 2. Deploy
gcloud run deploy cortex-mcp \
    --image "${REGISTRY}/cortex-mcp:latest" \
    --region us-central1 --project cortex-drive-496915 \
    --no-allow-unauthenticated --ingress all \
    --port 8080 --memory 1Gi --timeout 600 \
    --min-instances 0 --max-instances 3 \
    --set-secrets "NEO4J_URI=NEO4J_URI:latest,NEO4J_USERNAME=NEO4J_USERNAME:latest,\
NEO4J_PASSWORD=NEO4J_PASSWORD:latest,OPENAI_API_KEY=OPENAI_API_KEY:latest,\
TENANT_ID=TENANT_ID:latest,OWNER_USER_ID=OWNER_USER_ID:latest,\
OPENFGA_API_URL=OPENFGA_API_URL:latest,\
OPENFGA_STORE_ID=OPENFGA_STORE_ID:latest,\
OPENFGA_MODEL_ID=OPENFGA_MODEL_ID:latest,\
PERMIFY_API_URL=PERMIFY_API_URL:latest,\
PERMIFY_SCHEMA_VERSION=PERMIFY_SCHEMA_VERSION:latest,\
PERMIFY_TENANT_ID=PERMIFY_TENANT_ID:latest"
```

---

### 3. cortex-bento (Bento HTTP Server)

**Source:** `src/mcp_server/` — uses `Dockerfile.bento`, not `Dockerfile`.

**Workaround:** `gcloud builds submit --tag` only works with a file literally named `Dockerfile`.
Temporarily rename `Dockerfile.bento` → `Dockerfile` for the build, then restore.

```bash
REGISTRY="us-central1-docker.pkg.dev/cortex-drive-496915/cortex-images"

# 1. Build with Dockerfile rename workaround
cd /path/to/cortex-drive/src/mcp_server
cp Dockerfile Dockerfile.mcp.bak
cp Dockerfile.bento Dockerfile
gcloud builds submit --tag "${REGISTRY}/cortex-bento:latest" --project=cortex-drive-496915 .
cp Dockerfile.mcp.bak Dockerfile && rm Dockerfile.mcp.bak

# 2. Deploy
gcloud run deploy cortex-bento \
    --image "${REGISTRY}/cortex-bento:latest" \
    --region us-central1 --project cortex-drive-496915 \
    --no-allow-unauthenticated --ingress internal \
    --port 8080 --memory 512Mi --timeout 600 \
    --min-instances 0 --max-instances 3 \
    --set-secrets "NEO4J_URI=NEO4J_URI:latest,NEO4J_USERNAME=NEO4J_USERNAME:latest,\
NEO4J_PASSWORD=NEO4J_PASSWORD:latest,OPENAI_API_KEY=OPENAI_API_KEY:latest,\
TENANT_ID=TENANT_ID:latest,OWNER_USER_ID=OWNER_USER_ID:latest"
```

---

### 4. cortex-ui (Next.js Frontend)

**Source:** `cortex-chat-ui/` — exclude `node_modules/`, `.next/`, `.env*`, and `public/videos/`
(videos are large binaries that cause `No space left on device` errors during rsync/upload).

**Why cloudbuild.yaml:** The Dockerfile uses `ARG` for build-time env vars, not `ENV`. They
must be passed via `--build-arg` in the Docker build command, which requires a `cloudbuild.yaml`
(the `gcloud builds submit --tag` shortcut does not support `--build-arg`).

```bash
REGISTRY="us-central1-docker.pkg.dev/cortex-drive-496915/cortex-images"
CLERK_PK="pk_live_..."   # from cortex-chat-ui/.env.local.clerk-prod

# 1. Build minimal context (excludes videos and node_modules)
BCTX="/tmp/cortex-ui-ctx"
rm -rf "$BCTX" && mkdir -p "$BCTX"
rsync -a \
    --exclude='node_modules' \
    --exclude='.next' \
    --exclude='.env*' \
    --exclude='public/videos' \
    /path/to/cortex-drive/cortex-chat-ui/ "$BCTX/"

# 2. Write cloudbuild.yaml with build args
cat > "$BCTX/cloudbuild.yaml" << EOF
steps:
- name: 'gcr.io/cloud-builders/docker'
  args:
    - 'build'
    - '--build-arg'
    - 'NEXT_PUBLIC_GATEWAY_URL=https://api.cortex-drive.com'
    - '--build-arg'
    - 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${CLERK_PK}'
    - '-t'
    - '${REGISTRY}/cortex-ui:latest'
    - '.'
images:
- '${REGISTRY}/cortex-ui:latest'
timeout: '1200s'
EOF

# 3. Submit build (~5 min for Next.js compile)
cd "$BCTX"
gcloud builds submit --config cloudbuild.yaml --project=cortex-drive-496915 .

# 4. Deploy
gcloud run deploy cortex-ui \
    --image "${REGISTRY}/cortex-ui:latest" \
    --region us-central1 --project cortex-drive-496915 \
    --allow-unauthenticated \
    --port 3000 --memory 1Gi \
    --min-instances 0 --max-instances 3 \
    --set-env-vars "NEXT_PUBLIC_GATEWAY_URL=https://api.cortex-drive.com,NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${CLERK_PK}" \
    --set-secrets "CLERK_SECRET_KEY=CLERK_SECRET_KEY:latest"
```

---

### 5. cortex-openfga

**Image:** Public `openfga/openfga:latest` — no build step needed.

**Notes:**
- Requires `--args "run"` to start the HTTP server (without it, container prints help and exits)
- DB migration must run once before first start (or after schema changes): see bootstrap section below
- `--ingress all` with `--no-allow-unauthenticated`: every call requires a valid OIDC token;
  internal Cloud Run Jobs cannot reach `--ingress internal` services from outside the VPC

```bash
PROJECT_ID="cortex-drive-496915"
CLOUD_SQL_CONN="${PROJECT_ID}:us-central1:cortex-openfga-db"
OPENFGA_DB_PASSWORD="<from Secret Manager OPENFGA_DB_PASSWORD>"
OPENFGA_DB_URI="postgresql://openfga-user:${OPENFGA_DB_PASSWORD}@/openfga?host=/cloudsql/${CLOUD_SQL_CONN}"

# Run DB migration (one-off job — only needed after schema changes)
gcloud run jobs create openfga-migrate \
    --image "openfga/openfga:latest" \
    --region us-central1 --project "$PROJECT_ID" \
    --set-cloudsql-instances "$CLOUD_SQL_CONN" \
    --set-env-vars "OPENFGA_DATASTORE_ENGINE=postgres,OPENFGA_DATASTORE_URI=${OPENFGA_DB_URI}" \
    --args "migrate" --max-retries 1
gcloud run jobs execute openfga-migrate --region us-central1 --project "$PROJECT_ID" --wait

# Deploy service
gcloud run deploy cortex-openfga \
    --image "openfga/openfga:latest" \
    --region us-central1 --project "$PROJECT_ID" \
    --no-allow-unauthenticated \
    --ingress all \
    --port 8080 --memory 512Mi \
    --min-instances 0 --max-instances 2 \
    --set-cloudsql-instances "$CLOUD_SQL_CONN" \
    --set-env-vars "OPENFGA_DATASTORE_ENGINE=postgres,OPENFGA_DATASTORE_URI=${OPENFGA_DB_URI}" \
    --args "run"
```

---

## OpenFGA Bootstrap (run once, or after data wipe)

The bootstrap creates the OpenFGA store + authorization model and writes owner/tenant-viewer
tuples for all Neo4j nodes. Uses a dedicated Cloud Run Job so it runs inside GCP's network
and can reach `cortex-openfga`.

```bash
PROJECT_ID="cortex-drive-496915"
REGISTRY="us-central1-docker.pkg.dev/${PROJECT_ID}/cortex-images"
OPENFGA_URL="https://cortex-openfga-isabiovosq-uc.a.run.app"

# Build bootstrap image (only needed after changes to bootstrap scripts)
# See Dockerfile.bootstrap at repo root
cd /path/to/cortex-drive
BCTX="/tmp/cortex-bootstrap-ctx"
rm -rf "$BCTX" && mkdir -p "$BCTX/src/mcp_server" "$BCTX/scripts/openfga"
cp Dockerfile.bootstrap                          "$BCTX/Dockerfile"
cp src/mcp_server/requirements-docker.txt        "$BCTX/src/mcp_server/"
cp src/mcp_server/openfga_utils.py               "$BCTX/src/mcp_server/"
cp scripts/bootstrap_openfga.py                  "$BCTX/scripts/"
cp scripts/openfga/authorization_model.json      "$BCTX/scripts/openfga/"
cp scripts/openfga_bootstrap_entrypoint.sh       "$BCTX/scripts/"
cd "$BCTX"
gcloud builds submit --tag "${REGISTRY}/cortex-bootstrap:latest" --project="$PROJECT_ID" .

# Create and run bootstrap job
gcloud run jobs delete openfga-setup --region=us-central1 --project="$PROJECT_ID" --quiet 2>/dev/null || true
gcloud run jobs create openfga-setup \
    --image "${REGISTRY}/cortex-bootstrap:latest" \
    --region us-central1 --project "$PROJECT_ID" \
    --service-account "377406326936-compute@developer.gserviceaccount.com" \
    --set-env-vars "OPENFGA_API_URL=${OPENFGA_URL},TENANT_ID=org_3E0FtIXiFM6DHwXg05sEVvq2mi0,OWNER_USER_ID=user_3E07ZZZL4kDTo2vzAgpC1erDxjF,BOOTSTRAP_VISIBILITY=tenant-wide" \
    --set-secrets "NEO4J_URI=NEO4J_URI:latest,NEO4J_USERNAME=NEO4J_USERNAME:latest,NEO4J_PASSWORD=NEO4J_PASSWORD:latest" \
    --max-retries 0

gcloud run jobs execute openfga-setup --region=us-central1 --project="$PROJECT_ID" --wait

# Read STORE_ID and MODEL_ID from job logs, then store in Secret Manager:
# gcloud logging read "resource.labels.job_name=openfga-setup" --limit=20 --order=asc
# echo -n "<STORE_ID>" | gcloud secrets versions add OPENFGA_STORE_ID --data-file=- --project="$PROJECT_ID"
# echo -n "<MODEL_ID>"  | gcloud secrets versions add OPENFGA_MODEL_ID --data-file=- --project="$PROJECT_ID"
```

---

## Entity Catalog — Force Rebuild

The entity catalog (`cortex-gateway/config/entity_catalog.json`) is generated at gateway
build time and baked into the Docker image. It powers Phase E (entity name lookup) of the
intent classifier. The catalog reflects the Neo4j graph state at the time of the last gateway
deploy — new nodes added after a deploy are not indexed until the next one.

### When to rebuild

- New career node added to Neo4j (new Company, Project, ThoughtLeadership, etc.)
- New podcast episode or podcast title added
- Phase E is misclassifying a query that should be caught by entity name match

### How to rebuild

```bash
# From repo root, with cloud-env sourced
source scripts/cloud-env.sh

# Option A — Regenerate only, verify, then deploy
.venv/bin/python scripts/generate_entity_catalog.py
cat cortex-gateway/config/entity_catalog.json | python3 -m json.tool | grep -E '"node_count"|"career"|"podcast"'
bash scripts/build-deploy-gateway.sh

# Option B — Just redeploy (catalog auto-regenerates at start of build script)
bash scripts/build-deploy-gateway.sh
```

**Important:** The build script calls `.venv/bin/python` (not `python3`) for catalog generation.
If you see `ModuleNotFoundError: No module named 'neo4j'`, the venv is not active or the
wrong Python binary is being used. Use Option A above to run the script manually first.

If catalog generation fails, the build prints:
```
⚠ Entity catalog generation failed — using existing catalog from last deploy
```
This is non-fatal — the previous `entity_catalog.json` on disk is bundled instead.

### What the catalog contains

```json
{
  "generated_at": "<ISO timestamp>",
  "node_count": 44,
  "domains": {
    "career": ["JPMorgan Chase", "Cortex-Drive", "InfoQ: Architectural Shifts...", ...],
    "podcast": ["Software Engineering Daily", "Data Engineering Podcast", ...]
  }
}
```

Only unambiguously domain-specific labels are indexed (career: Company, Project, Startup,
ThoughtLeadership, etc.; podcast: Episode, Podcast). Shared/SYSTEM labels (Topic, Concept,
Technology, Person) are intentionally excluded to prevent misclassification.

---

## Synchronized MCP + Gateway Deploy

Some changes require both `cortex-mcp` and `cortex-gateway` to be deployed together because
they share the domain label contract (`domain_registry.py` ↔ `domain_manifests.json`).

**When this is needed:** Any change to `domain_registry.py` (authorized labels, anchor labels,
backbone labels, domain manifests) must be paired with a matching change to
`cortex-gateway/config/domain_manifests.json` and both services redeployed.

**Deploy MCP first** — gateway reads MCP responses, so MCP must be consistent before
the gateway starts using the updated config:

```bash
source scripts/cloud-env.sh
bash scripts/build-deploy-mcp.sh     # MCP first — domain_registry.py changes live here
bash scripts/build-deploy-gateway.sh # Gateway second — domain_manifests.json + index.js
```

---

## Deployment Order

Deploy in this order when bootstrapping from scratch or after a full teardown.
For single-service updates, only that service needs to be redeployed.

| Order | Service | Dependency reason |
|---|---|---|
| 1 | `cortex-openfga` | No upstream dependencies; gateway + bootstrap job need it |
| 2 | `cortex-permify` | No upstream dependencies; MCP + Bento need `PERMIFY_API_URL` |
| 3 | `cortex-mcp` | No upstream dependencies; gateway calls it |
| 4 | `cortex-bento` | No upstream dependencies; gateway calls it |
| 5 | `cortex-gateway` | Needs MCP + Bento URLs and OpenFGA + Permify secrets at deploy time |
| 6 | `cortex-ui` | Needs `NEXT_PUBLIC_GATEWAY_URL` baked at build time |

---

## Service Status and Logs

### Verify a deploy succeeded

After running a build+deploy script, confirm the new revision is live before testing:

```bash
# Show latest ready revision name + service URL
gcloud run services describe cortex-gateway \
    --region=us-central1 --project=cortex-drive-496915 \
    --format="value(status.latestReadyRevisionName,status.url)"
# → cortex-gateway-00043-j6s   https://cortex-gateway-isabiovosq-uc.a.run.app

# List last 3 revisions with status (True = ready)
gcloud run revisions list --service=cortex-gateway \
    --region=us-central1 --project=cortex-drive-496915 \
    --limit=3 \
    --format="table(name,status.conditions[0].status,createTime)"

# Same for MCP
gcloud run revisions list --service=cortex-mcp \
    --region=us-central1 --project=cortex-drive-496915 \
    --limit=3 \
    --format="table(name,status.conditions[0].status,createTime)"
```

A revision with `STATUS=True` is ready and serving traffic. If the latest revision shows
`STATUS=False`, the deploy failed — check `gcloud run revisions describe <revision-name>`
for the error reason.

### Check all services are Ready

```bash
for svc in cortex-ui cortex-gateway cortex-mcp cortex-bento cortex-openfga cortex-permify; do
    STATUS=$(gcloud run services describe "$svc" \
        --region=us-central1 --project=cortex-drive-496915 \
        --format='value(status.conditions[0].status)' 2>&1)
    echo "$svc: $STATUS"
done
```

### Read logs for any service

```bash
# Last 50 lines
gcloud run services logs read cortex-gateway \
    --region=us-central1 --project=cortex-drive-496915 --limit=50

gcloud run services logs read cortex-mcp \
    --region=us-central1 --project=cortex-drive-496915 --limit=50

gcloud run services logs read cortex-bento \
    --region=us-central1 --project=cortex-drive-496915 --limit=50

gcloud run services logs read cortex-openfga \
    --region=us-central1 --project=cortex-drive-496915 --limit=50

gcloud run services logs read cortex-permify \
    --region=us-central1 --project=cortex-drive-496915 --limit=50
```

### What to look for in gateway logs (healthy query)

```
[GATEWAY] Calling MCP tool search_enterprise_graph
[GATEWAY] SSE Connection established.
[GATEWAY] Discovered endpoint: https://cortex-mcp-.../messages/...
[GATEWAY] MCP Initialized response received. Sending notification.
[GATEWAY] Handshake complete. Calling tool: search_enterprise_graph
[GATEWAY] SUCCESS: Received tool result for search_enterprise_graph
```

If you see `[GATEWAY] Tool call failed — <tool>: <error>` instead, the error message now
identifies the layer: `Failed to connect to SSE: Not Found` = wrong MCP URL or path;
`Failed to connect to SSE: unknown` = 421 Misdirected Request (Host header issue);
`Failed to connect to SSE: Forbidden` = OIDC auth failure.

### What to look for in cortex-mcp logs (healthy query)

```
INFO:     Started server process [1]
INFO:     Application startup complete.
INFO:     Uvicorn running on http://0.0.0.0:8080
GET /sse HTTP/1.1  200
POST /messages/... HTTP/1.1  202
```

If the service has `--min-instances 0` it scales to zero when idle and will show startup
logs again on each cold start. This is normal.

### Structured log inspection — filtering and freshness

The `gcloud logging read` command is more powerful than `gcloud run services logs read`
for filtering specific events across a time window:

```bash
# Last 2 hours of gateway logs — all lines
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="cortex-gateway"' \
  --project=cortex-drive-496915 --limit=100 \
  --format="value(timestamp,textPayload)" --freshness=2h

# Filter for a specific user's queries (replace user ID)
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="cortex-gateway"' \
  --project=cortex-drive-496915 --limit=50 \
  --format="value(timestamp,textPayload)" --freshness=2h 2>/dev/null \
  | grep "user_3GHkXgBrnxw04FQzUBffuiALWK1"

# Filter for classification decisions only
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="cortex-gateway"' \
  --project=cortex-drive-496915 --limit=100 \
  --format="value(timestamp,textPayload)" --freshness=2h 2>/dev/null \
  | grep -E "\[CLASSIFY\]|\[QUERY\] domain"

# Filter for Permify errors
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="cortex-gateway"' \
  --project=cortex-drive-496915 --limit=50 \
  --format="value(timestamp,textPayload)" --freshness=1h 2>/dev/null \
  | grep -E "PERMIFY|FGA"

# Filter for cache events (hits, writes, keys)
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="cortex-gateway"' \
  --project=cortex-drive-496915 --limit=100 \
  --format="value(timestamp,textPayload)" --freshness=2h 2>/dev/null \
  | grep -E "PERM-CACHE|cached|cache"

# Filter for tool calls and results
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="cortex-gateway"' \
  --project=cortex-drive-496915 --limit=100 \
  --format="value(timestamp,textPayload)" --freshness=2h 2>/dev/null \
  | grep -E "\[QUERY LOOP\]|\[GATEWAY\] Calling MCP|\[GATEWAY\] SUCCESS"
```

**Key log prefixes in the gateway** — what each means:

| Prefix | Meaning |
|---|---|
| `[CLASSIFY] phase=R(regex)` | Intent classified by regex (free) |
| `[CLASSIFY] phase=E(entity)` | Intent classified by entity catalog lookup (free) |
| `[CLASSIFY] phase=S(embedding)` | Intent classified by embedding similarity (paid ~$0.0000004) |
| `[QUERY] domain_signal=career` | Domain resolved; downstream tools and writer selected |
| `[QUERY] Career override: wants_visual_map→false` | AP-20 applied |
| `[FGA/QUERY] access_scope=normal allowed_ids_count=342` | Permify returned N viewable nodes |
| `[FGA/QUERY] access_scope=legacy` | Permify failed; fallback to owner-only access |
| `[PERM-CACHE] hit` | Permission list served from Redis cache (no Permify call) |
| `[QUERY LOOP 1] Executing search_enterprise_graph` | LLM chose to call this tool |
| `[QUERY] Response cached — key 0a656a32…` | Response written to semantic cache |
| `[Q2] fetchNodeNarratives failed for "X"` | Q2 writer GPT-4o call timed out for node X |
| `[QUERY] Auto-injected career backbone nodes: N` | Backbone auto-inject succeeded |
| `[GROUNDING]` | `auditResponseUrls()` stripped a hallucinated URL (AP-15) |

**Diagnosing "LLM skipped tool calls"** — look for a response cached in <2s with no
`[QUERY LOOP]` or `[GATEWAY] Calling MCP` lines between `[QUERY] domain_signal` and
`[QUERY] Response cached`. This means the LLM answered from training data.

### Describe a specific revision

```bash
# List revisions
gcloud run revisions list --service=cortex-mcp \
    --region=us-central1 --project=cortex-drive-496915

# Describe latest revision config (check ingress, env vars, secrets)
gcloud run services describe cortex-mcp \
    --region=us-central1 --project=cortex-drive-496915 \
    --format='yaml(spec.template.metadata.annotations, spec.template.spec.containers[0].env)'
```

---

## Quick Smoke Tests After Any Deploy

```bash
GATEWAY="https://api.cortex-drive.com"

# Health check
curl "${GATEWAY}/health"
# → {"status":"ok"}

# Auth gate (expect 401)
curl -X POST "${GATEWAY}/query" -H "Content-Type: application/json" -d '{"question":"test"}'
# → 401 Unauthorized

# CORS restriction
curl -si -X OPTIONS "${GATEWAY}/query" \
  -H "Origin: https://app.cortex-drive.com" \
  -H "Access-Control-Request-Method: POST" | grep access-control-allow-origin
# → access-control-allow-origin: https://app.cortex-drive.com

# Q1/Q2/Q3 with JWT — get token from browser DevTools after logging in at app.cortex-drive.com
JWT="<paste-token>"
curl -X POST "${GATEWAY}/query" \
  -H "Authorization: Bearer ${JWT}" -H "Content-Type: application/json" \
  -d '{"question":"Show career map of Sangeetha Ramadurai","history":[]}'
# → raw_data.nodes non-empty, domain_signal=career
```

Full Q1/Q2/Q3 test commands and Permify authorization checks:
`documents/cortex-drive-documents/cloud-deployment-smoke-test-runbook.md`

---

## Reference

| File | Purpose |
|---|---|
| `cortex-gateway/index.js` lines 457–460 | CORS `ALLOWED_ORIGIN` configuration |
| `cortex-gateway/Dockerfile` | Gateway container (built from repo root context) |
| `src/mcp_server/Dockerfile` | MCP SSE server container |
| `src/mcp_server/Dockerfile.bento` | Bento HTTP server container |
| `cortex-chat-ui/Dockerfile` | Next.js frontend (multi-stage, uses `ARG` for build-time vars) |
| `Dockerfile.bootstrap` | OpenFGA bootstrap job container |
| `scripts/deploy-gcp.sh` | Full automated deployment script (Phases 6–9) |
| `scripts/openfga_bootstrap_entrypoint.sh` | Bootstrap entrypoint (store setup + tuple write) |
| `documents/cortex-drive-documents/cloud-move-implementation-plan-2026-05-14.md` | Original migration plan |
| `documents/cortex-drive-documents/local-dev-runbook-2026-06-04.md` | Local dev setup + env switching |
