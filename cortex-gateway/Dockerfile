# Build context: cortex-drive project root (one level above cortex-gateway/)
# gcloud builds submit --tag ... .  (run from project root, not from cortex-gateway/)
FROM node:20-alpine
WORKDIR /app
COPY cortex-gateway/package*.json ./
RUN npm ci --omit=dev
COPY cortex-gateway/index.js ./
COPY cortex-gateway/config/ ./config/
COPY cortex-gateway/utils/ ./utils/
# The daily maintenance job (S2-50 build 2c, scripts/deploy-maintenance-job.sh) runs these two from this image.
COPY cortex-gateway/scripts/retention_purge.js cortex-gateway/scripts/reconcile_offboarding.js ./scripts/
# prompts are at ../prompts relative to index.js (__dirname = /app, so /prompts)
COPY prompts/ /prompts/
ENV PORT=8080
EXPOSE 8080
CMD ["node", "index.js"]
