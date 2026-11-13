// The gateway's base address, for every call the UI makes to it. Set at build time (scripts/build-deploy-ui.sh
// passes NEXT_PUBLIC_GATEWAY_URL); the fallback is the local gateway (CLAUDE.md service map).
const LOCAL_GATEWAY_URL = "http://localhost:4000";
export const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL || LOCAL_GATEWAY_URL;
