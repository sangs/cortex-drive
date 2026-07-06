# Pending Manual Steps — Cortex-Drive

Steps that require action outside the codebase (Clerk dashboard, GCP console,
DNS panel, third-party accounts). Each step is marked with its current status
and exact instructions.

Last updated: 2026-07-06

---

## A — Clerk Webhook (user.created → provision pending grants)

**Status:** ❌ Not configured — CLERK_WEBHOOK_SECRET secret does not exist in GCP.

**What it does:** When a new user signs up via Clerk, Cortex-Drive immediately
provisions any pending share grants for their email without waiting for first login.

### Steps

1. Go to [Clerk Dashboard](https://dashboard.clerk.com) → your production application
2. Left sidebar → **Webhooks** → **Add Endpoint**
3. Set **Endpoint URL**: `https://api.cortex-drive.com/api/webhooks/clerk`
4. Under **Events**, check: `user.created`
5. Click **Create**. On the next screen copy the **Signing Secret** (starts with `whsec_...`)

6. Add to GCP Secret Manager:
```bash
echo -n "whsec_PASTE_YOUR_SECRET_HERE" | \
  gcloud secrets create CLERK_WEBHOOK_SECRET \
  --data-file=- --replication-policy="automatic" --project=cortex-drive-496915

gcloud secrets add-iam-policy-binding CLERK_WEBHOOK_SECRET \
  --member="serviceAccount:377406326936-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor" --project=cortex-drive-496915
```

7. Add to `scripts/build-deploy-gateway.sh` — append to the `--set-secrets` line:
```
,CLERK_WEBHOOK_SECRET=CLERK_WEBHOOK_SECRET:latest
```

8. Redeploy gateway:
```bash
source scripts/cloud-env.sh && bash scripts/build-deploy-gateway.sh
```

9. Verify in Clerk dashboard: send a test event → should see `200 OK`.

**Fallback if skipped:** The pull model (`POST /api/auth/activate-pending`) runs on
first dashboard load and covers the same cases within ~1 minute of first login.

---

## B — Resend Email (invite notifications for pending grants)

**Status:** ❌ Not configured — RESEND_API_KEY secret does not exist in GCP.
Invite emails are silently skipped until this key is set.

**What it does:** When you share with an email that has no Cortex-Drive account,
CortexDrive sends a branded transactional email: "Sangeetha shared a knowledge
graph with you. Sign up to view it."

### Prerequisites

- [ ] Microsoft 365 subscription for `cortex-drive.com` is active (you said this is done)
- [ ] Resend account created at [resend.com](https://resend.com) (free tier, no credit card)

### Steps

**Step B-1: Add Resend as a sending domain**

1. In Resend dashboard → **Domains** → **Add Domain** → enter `cortex-drive.com`
2. Resend will show 3 DNS records to add. Add them in your DNS panel:

| Type | Name | Value |
|---|---|---|
| TXT | `resend._domainkey.cortex-drive.com` | `v=DKIM1; k=rsa; p=<key from Resend>` |
| MX | `send.cortex-drive.com` | Resend MX value |
| TXT | `send.cortex-drive.com` | SPF value |

3. Microsoft 365 DKIM uses `selector1._domainkey` and `selector2._domainkey` — these
   are different selectors, no conflict.

4. Update your existing SPF record on `cortex-drive.com` to include Resend:
```
v=spf1 include:spf.protection.outlook.com include:_spf.resend.com ~all
```

5. Click **Verify** in Resend — propagation takes 5–60 minutes.

**Step B-2: Get API key**

1. Resend dashboard → **API Keys** → **Create API Key**
2. Name: `cortex-drive-gateway-prod`
3. Permission: `Full access` (or `Sending access` minimum)
4. Copy the key (shown once, starts with `re_...`)

**Step B-3: Store in GCP and deploy**

```bash
echo -n "re_PASTE_YOUR_KEY_HERE" | \
  gcloud secrets create RESEND_API_KEY \
  --data-file=- --replication-policy="automatic" --project=cortex-drive-496915

gcloud secrets add-iam-policy-binding RESEND_API_KEY \
  --member="serviceAccount:377406326936-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor" --project=cortex-drive-496915
```

Add to `scripts/build-deploy-gateway.sh` `--set-secrets` line:
```
,RESEND_API_KEY=RESEND_API_KEY:latest
```

Redeploy gateway:
```bash
source scripts/cloud-env.sh && bash scripts/build-deploy-gateway.sh
```

**Verification:** Share a graph with a non-existent email via the UI → should receive
an invite email from `noreply@cortex-drive.com` within ~30 seconds.

---

## C — Settings UI for Group Management

**Status:** ❌ Not built — groups can only be created via API currently.

**What it does:** A `/settings/groups` page where you can create named groups
(e.g., "Primary Evaluators", "Recruiters"), add/remove members by email, and
see which groups have access to which shared nodes.

**Unblocked:** Backend 100% complete (5 group CRUD routes live in gateway).
Frontend work only.

**To implement:** Create `cortex-chat-ui/app/settings/groups/page.tsx` — list
groups, create group form, member management per group. Uses `GET /api/groups`,
`POST /api/groups`, `POST /api/groups/:id/members`, `DELETE /api/groups/:id/members/:sub`.

---

## D — Domain Email Setup (cortex-drive.com inbox)

**Status:** ✅ Done (user confirmed Microsoft 365 is set up for cortex-drive.com)

**What it enables:** Required for Resend domain verification (Step B above).

---

## E — Permify Schema Version Pinning

**Status:** ⚠️ Monitor — PERMIFY_SCHEMA_VERSION is set in deploy script but
verify it matches the live schema version after any Permify schema changes.

**How to check:**
```bash
gcloud run services describe cortex-gateway --region=us-central1 \
  --format="value(spec.template.spec.containers[0].env)" | grep PERMIFY_SCHEMA
```

---

## Completed Steps (for reference)

| Step | Date | Details |
|---|---|---|
| Migration 001: share_grants table | 2026-07 | via Cloud SQL Auth Proxy |
| Migration 002: groups + group_members | 2026-07 | via Cloud SQL Auth Proxy |
| Migration 003: share_grants grant_type + group_id | 2026-07 | via Cloud SQL Auth Proxy |
| Migration 004: graph_share_links | 2026-07-06 | via Cloud SQL Auth Proxy |
| Migration 005: share_grants pending_email + user_email | 2026-07-06 | via Cloud SQL Auth Proxy |
| All 4 Cloud Run services deployed | 2026-07-06 | gateway-00019, ui-00015 |
| Permify 683 tuples migrated | 2026-06 | see how-to-google-cloud-operations.md |
