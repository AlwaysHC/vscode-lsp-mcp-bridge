import { brandAttribution } from "../branding.js";

// Codex uses the first 512 characters while deciding whether to expose/use an MCP
// server. Keep this prefix self-contained and focused on proactive tool selection.
export const toolSelectionInstructions = "Before any shell command, file read, or text search in a coding task, call semantic_navigation_guide as the first tool action; the user need not mention LSP. Then use the matching VS Code semantic tool for code understanding, navigation, diagnostics, review, and edits. This includes symbols, definitions, implementations, references, callers/callees, hover, diagnostics, rename, code actions, and formatting. Use text search only when the provider fails or the user explicitly requests textual search.";

export const languageMcpServerInstructions = [
  toolSelectionInstructions,
  "For named-symbol questions, prefer the task-shaped tools: find_callers_for_symbol for who calls X/incoming calls/callers; find_callees_for_symbol for what X calls/outgoing calls/callees; find_references_for_symbol for usages; find_definition_for_symbol for definitions.",
  "Use symbol_context or symbol_context_for_symbol when one bounded request should gather definitions, implementations, references, hover, containing symbols, callers, and callees.",
  "If the exact symbol position is unknown, use workspace_symbols or document_symbols to locate it, then call the position-based tool.",
  "Tool inputs and results use one-based editor line and column values.",
  "Location-list tools include sourceLine when available; use it to summarize reference intent before falling back to raw file reads or text search.",
  "Tool results are compact for LLM use: use file, line, column, and sourceLine directly in user-facing answers and follow-up tool calls.",
  "Formatting and plain-text completion tools only apply validated, workspace-contained edits when vscodeLspMcpBridge.enableWriteTools is true and the user approves the VS Code modal confirmation.",
  "Provider WorkspaceEdit results, including rename and edit-based code actions, are preview-only because stable VS Code APIs cannot enumerate hidden resource, notebook, or snippet operations safely.",
  "Provider commands are excluded by default and require explicit request plus a separate warning because their effects cannot be previewed or workspace-confined.",
  brandAttribution
].join(" ");
