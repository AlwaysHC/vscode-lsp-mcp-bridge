const startMarker = "<!-- vscode-lsp-mcp-bridge:codex-guidance:start -->";
const endMarker = "<!-- vscode-lsp-mcp-bridge:codex-guidance:end -->";

const guidanceLines = [
  startMarker,
  "## VS Code LSP MCP Bridge",
  "",
  "- Before locating, reading, analyzing, or editing code, call the `vscode_lsp` MCP server's `semantic_navigation_guide` as the first tool action. The user does not need to mention LSP.",
  "- Use the matching `vscode_lsp` semantic tool before `rg`, `grep`, shell search, or raw file search for symbols, methods, definitions, declarations, implementations, references, callers, callees, hover, diagnostics, rename, code actions, and formatting.",
  "- If a symbol name or method signature is provided, locate it with `workspace_symbols`, `document_symbols`, or a task-shaped named-symbol tool instead of text search.",
  "- Fall back to text search only when the bridge is unavailable or the language provider fails, and state that fallback explicitly.",
  endMarker
] as const;

export const codexGuidanceBlock = guidanceLines.join("\n");

function guidanceRange(content: string): readonly [start: number, end: number] | undefined {
  const start = content.indexOf(startMarker);
  if (start < 0) {
    return undefined;
  }

  const markerEnd = content.indexOf(endMarker, start + startMarker.length);
  return markerEnd < 0 ? undefined : [start, markerEnd + endMarker.length];
}

function blockFor(content: string): string {
  return codexGuidanceBlock.replaceAll("\n", content.includes("\r\n") ? "\r\n" : "\n");
}

export function upsertCodexGuidance(content: string): string {
  const range = guidanceRange(content);
  if (range) {
    return `${content.slice(0, range[0])}${blockFor(content)}${content.slice(range[1])}`;
  }

  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const prefix = content.trimEnd();
  return `${prefix}${prefix ? `${eol}${eol}` : ""}${blockFor(content)}${eol}`;
}

export function removeCodexGuidance(content: string): string {
  const range = guidanceRange(content);
  if (!range) {
    return content;
  }

  const before = content.slice(0, range[0]).trimEnd();
  const after = content.slice(range[1]).trimStart();
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  return before && after ? `${before}${eol}${eol}${after}` : `${before}${after}`;
}
