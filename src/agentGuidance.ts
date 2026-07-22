export interface ManagedGuidance {
  clientName: string;
  startMarker: string;
  endMarker: string;
  block: string;
}

const guidanceBody = [
  "## VS Code LSP MCP Bridge",
  "",
  "- Before locating, reading, analyzing, or editing code, call the `vscode_lsp` MCP server's `semantic_navigation_guide` as the first tool action. The user does not need to mention LSP.",
  "- Use the matching `vscode_lsp` semantic tool before `rg`, `grep`, shell search, or raw file search for symbols, methods, definitions, declarations, implementations, references, callers, callees, hover, diagnostics, rename, code actions, and formatting.",
  "- If a symbol name or method signature is provided, locate it with `workspace_symbols`, `document_symbols`, or a task-shaped named-symbol tool instead of text search.",
  "- Fall back to text search only when the bridge is unavailable or the language provider fails, and state that fallback explicitly."
] as const;

function createGuidance(clientName: string, markerName: string): ManagedGuidance {
  const startMarker = `<!-- vscode-lsp-mcp-bridge:${markerName}-guidance:start -->`;
  const endMarker = `<!-- vscode-lsp-mcp-bridge:${markerName}-guidance:end -->`;
  return {
    clientName,
    startMarker,
    endMarker,
    block: [startMarker, ...guidanceBody, endMarker].join("\n")
  };
}

export const codexGuidance = createGuidance("Codex", "codex");
export const claudeCodeGuidance = createGuidance("Claude Code", "claude-code");

function guidanceRange(content: string, guidance: ManagedGuidance): readonly [start: number, end: number] | undefined {
  const start = content.indexOf(guidance.startMarker);
  if (start < 0) {
    return undefined;
  }

  const markerEnd = content.indexOf(guidance.endMarker, start + guidance.startMarker.length);
  return markerEnd < 0 ? undefined : [start, markerEnd + guidance.endMarker.length];
}

function blockFor(content: string, guidance: ManagedGuidance): string {
  return guidance.block.replaceAll("\n", content.includes("\r\n") ? "\r\n" : "\n");
}

export function upsertGuidance(content: string, guidance: ManagedGuidance): string {
  const range = guidanceRange(content, guidance);
  if (range) {
    return `${content.slice(0, range[0])}${blockFor(content, guidance)}${content.slice(range[1])}`;
  }

  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const prefix = content.trimEnd();
  return `${prefix}${prefix ? `${eol}${eol}` : ""}${blockFor(content, guidance)}${eol}`;
}

export function removeGuidance(content: string, guidance: ManagedGuidance): string {
  const range = guidanceRange(content, guidance);
  if (!range) {
    return content;
  }

  const before = content.slice(0, range[0]).trimEnd();
  const after = content.slice(range[1]).trimStart();
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  return before && after ? `${before}${eol}${eol}${after}` : `${before}${after}`;
}
