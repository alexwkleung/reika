// The namespace Reika puts on a server's tools when it hands them to the model: `mcp__<server>__
// <tool>`. A module with no imports of its own, because both ends read it — the bridge that builds
// the name (tools.ts) and the UI that spells it back as `/<server>:<tool>` (display/format.ts, which the
// browser client also bundles) — and tools.ts already imports display/format.ts for `kFormat`, so a
// constant shared from there would close the loop.
export const MCP_TOOL_PREFIX = 'mcp__';
