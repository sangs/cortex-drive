// Bridge target domains as returned by the list_bridge_domains MCP tool
// (bridge-discovery-and-bento-panel-design-2026-11-03.md §1). The server owns the list.
export type BridgeDomainOption = { id: string; display_name: string; has_visible_content: boolean };
export type BridgeOptions = { auto: string; domains: BridgeDomainOption[] };
