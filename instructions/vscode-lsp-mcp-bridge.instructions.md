---
name: Prefer VS Code language tools
description: Use semantic VS Code language intelligence before text search for code navigation, diagnostics, and edits.
applyTo: "**"
---

# VS Code LSP MCP Bridge

- Before locating, reading, analyzing, or editing code, call the `vscode_lsp` MCP server's `semantic_navigation_guide` as the first tool action. The user does not need to mention LSP.
- Use the matching `vscode_lsp` semantic tool before `rg`, `grep`, shell search, or raw file search for symbols, methods, definitions, declarations, implementations, references, callers, callees, hover, diagnostics, rename, code actions, and formatting.
- If a symbol name or method signature is provided, locate it with `workspace_symbols`, `document_symbols`, or a task-shaped named-symbol tool instead of text search.
- Fall back to text search only when the bridge is unavailable or the language provider fails, and state that fallback explicitly.
