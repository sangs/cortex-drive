# Build context: cortex-drive project root (one level above cortex-gateway/)
# gcloud builds submit --tag ... .  (run from project root, not from cortex-gateway/)
FROM node:20-alpine
WORKDIR /app
COPY cortex-gateway/package*.json ./
RUN npm ci --omit=dev
COPY cortex-gateway/index.js ./
COPY cortex-gateway/config/ ./config/
COPY cortex-gateway/utils/ ./utils/
# prompts are at ../prompts relative to index.js (__dirname = /app, so /prompts)
COPY prompts/ /prompts/
ENV PORT=8080
EXPOSE 8080
CMD ["node", "index.js"]
