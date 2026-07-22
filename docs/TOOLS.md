# Tool Catalog

Tool inputs and results use one-based editor `line` and `column` values. Location-list results also include `sourceLine` when VS Code can open the target document. Results are intentionally compact for LLM use: prefer the returned `file`, `line`, `column`, and `sourceLine` fields directly in user-facing answers and follow-up calls.

## Scope

The bridge exposes VS Code's public language-provider command surface. It works with any installed language extension that implements the relevant VS Code APIs. In a C# workspace this usually routes through C# Dev Kit/Roslyn; in other workspaces it routes through that language's VS Code provider.

This does not expose private language-server process internals or every possible LSP request that a language server may support outside VS Code's public extension API.

## Tool Choice Guidance

Clients should use these tools proactively whenever they apply to a coding task; the user does not need to mention LSP or the bridge. The server advertises this rule in the decision-critical first 512 characters of its MCP instructions for clients such as Codex.

For references, definitions, implementations, callers/callees, type hierarchy, diagnostics, hover, rename, code actions, formatting, and symbol lookup, use this MCP server before shell commands, `rg`/`grep`, or raw file search.

If the exact symbol position is unknown, prefer the task-shaped symbol tools first:

- `find_callers_for_symbol` for "who calls X", incoming calls, callers, and caller file/line answers.
- `find_callees_for_symbol` for outgoing calls and callees.
- `find_references_for_symbol` for usages/references by symbol name.
- `find_definition_for_symbol` for definitions by symbol name.

Use `workspace_symbols` or `document_symbols` to disambiguate names, or when you need a file/line/column for a position-based tool.

Do not use text search as a cross-check unless the user asks for text search or the language provider fails. State any fallback clearly.

`semantic_navigation_guide` returns this routing guidance as a tool result for clients that do not strongly surface MCP server instructions. `language_capabilities` reports the public VS Code command surface used by the bridge and identifies features that stable consumer APIs cannot query.

## Position Tools

Input:

```json
{
  "file": "absolute-within-workspace/or/workspace-relative/path.cs",
  "line": 10,
  "column": 15
}
```

Tools:

- `find_references`
- `go_to_definition`
- `go_to_declaration`
- `go_to_implementation`
- `go_to_type_definition`
- `hover`
- `document_highlights`
- `symbol_context`
- `call_hierarchy`
- `type_hierarchy`
- `selection_ranges`
- `completion`
- `signature_help`
- `prepare_rename`
- `preview_rename`
- `rename_symbol`
- `format_on_type`

## Symbol Query Tools

Input:

```json
{
  "query": "AgendasController.GetBySalonInternal",
  "kind": "Method"
}
```

Tools:

- `semantic_navigation_guide`
- `find_callers_for_symbol`
- `find_callees_for_symbol`
- `find_references_for_symbol`
- `find_definition_for_symbol`
- `symbol_context_for_symbol`
- `workspace_symbols`
- `call_hierarchy_for_symbol`
- `type_hierarchy_for_symbol`

Use these when the caller knows a symbol name but not an exact file position.

## Document And Range Tools

Document input:

```json
{
  "file": "absolute-within-workspace/or/workspace-relative/path.cs"
}
```

Range input:

```json
{
  "file": "path.cs",
  "startLine": 10,
  "startColumn": 1,
  "endLine": 20,
  "endColumn": 1
}
```

Tools:

- `document_symbols`
- `diagnostics`
- `document_links`
- `semantic_tokens`
- `range_semantic_tokens`
- `folding_ranges`
- `document_colors`
- `color_presentations`
- `inline_values`
- `code_lens`
- `inlay_hints`
- `code_actions`
- `format_document`
- `format_range`

`diagnostics` can filter by severity, tag, source, code, or message and can wait for a bounded quiet period. Hierarchy tools accept bounded depth/node/edge limits and return graph roots, opaque node IDs, nodes, edges, errors, and truncation metadata.

`completion` returns rich, bounded item metadata. Applicable plain-text items include short-lived `completionId` values; snippets, truncated edit sets, and provider commands are preview-only. Use `apply_completion` with the same file anchor to request a validated application tied to the same open document instance and version.

Provider locations outside the workspace never expose their raw URI. Eligible provider-backed documents receive an opaque `virtualDocumentRef`; `read_virtual_document` requires that reference, a workspace file routing anchor, a first-use modal approval, and bounded line/character limits.

Range fields are optional for `inlay_hints`, `code_actions`, and `inline_values`; omitting them means the whole document.

## Write Tools

Validated formatting/completion writes and provider-command execution require both the global setting:

```json
"vscodeLspMcpBridge.enableWriteTools": true
```

and a per-operation VS Code modal approval. Text edits are confined to canonical workspace paths, insertion and replacement spans are bounded, overlaps are rejected, and approval is tied to the unchanged document instance and version. Provider commands require a separate warning because their effects cannot be previewed or workspace-confined.

Generic provider `WorkspaceEdit` values are preview-only. The stable VS Code API exposes plain text entries but cannot enumerate hidden create/delete/rename, notebook, or snippet operations; applying only the visible subset could corrupt a refactor.

Write-capable tools:

- `apply_code_action`
- `organize_imports`
- `fix_all`
- `apply_completion`
- `format_document`
- `format_range`
- `format_on_type`

`apply_code_action`, `organize_imports`, and `fix_all` can execute only command-only actions when `executeCommand: true` is explicitly supplied and the separate command warning is approved. Edit-based actions remain previews. `rename_symbol` is retained for compatibility but safely refuses `apply: true`; use `preview_rename` or omit `apply`, review the result, and perform the rename in VS Code.

Examples:

```json
{
  "file": "path.cs",
  "line": 10,
  "column": 15,
  "newName": "NewSymbolName",
  "apply": false
}
```

```json
{
  "file": "path.cs",
  "kind": "source.organizeImports",
  "apply": false
}
```

```json
{
  "file": "path.cs",
  "actionIndex": 1,
  "executeCommand": true
}
```

## Useful Workflows

Find callers by symbol name:

```json
{
  "query": "AgendasController.GetBySalonInternal",
  "kind": "Method"
}
```

Full call hierarchy by symbol name:

```json
{
  "query": "AgendasController.GetBySalonInternal",
  "kind": "Method"
}
```

Inspect a quick fix:

1. Call `code_actions` with a file and range.
2. Inspect `actionIndex`, `title`, `kind`, and `edit`.
3. Edit-based actions remain preview-only. For a command-only action, call `apply_code_action` with the selected `actionIndex` or exact `title` and `executeCommand: true`, then approve the separate VS Code warning.

Inspect semantic classification:

```json
{
  "file": "path.cs",
  "startLine": 10,
  "startColumn": 1,
  "endLine": 25,
  "endColumn": 1
}
```

Use `range_semantic_tokens` when the full document token result would be too large.
