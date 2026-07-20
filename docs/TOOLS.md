# Tool Catalog

Tool inputs and results use one-based editor `line` and `column` values. Location-list results also include `sourceLine` when VS Code can open the target document. Results are intentionally compact for LLM use: prefer the returned `file`, `line`, `column`, and `sourceLine` fields directly in user-facing answers and follow-up calls.

## Scope

The bridge exposes VS Code's public language-provider command surface. It works with any installed language extension that implements the relevant VS Code APIs. In a C# workspace this usually routes through C# Dev Kit/Roslyn; in other workspaces it routes through that language's VS Code provider.

This does not expose private language-server process internals or every possible LSP request that a language server may support outside VS Code's public extension API.

## Tool Choice Guidance

Use these tools as the primary source for semantic code navigation in the active VS Code workspace.

For references, definitions, implementations, callers/callees, type hierarchy, diagnostics, hover, rename, code actions, formatting, and symbol lookup, use this MCP server before shell commands, `rg`/`grep`, or raw file search.

If the exact symbol position is unknown, prefer the task-shaped symbol tools first:

- `find_callers_for_symbol` for "who calls X", incoming calls, callers, and caller file/line answers.
- `find_callees_for_symbol` for outgoing calls and callees.
- `find_references_for_symbol` for usages/references by symbol name.
- `find_definition_for_symbol` for definitions by symbol name.

Use `workspace_symbols` or `document_symbols` to disambiguate names, or when you need a file/line/column for a position-based tool.

Do not use text search as a cross-check unless the user asks for text search or the language provider fails. State any fallback clearly.

`semantic_navigation_guide` returns this routing guidance as a tool result for clients that do not strongly surface MCP server instructions.

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

Range fields are optional for `inlay_hints`, `code_actions`, and `inline_values`; omitting them means the whole document.

## Write Tools

Write tools preview by default where practical. Applying edits requires both the global setting:

```json
"vscodeLspMcpBridge.enableWriteTools": true
```

and a per-operation VS Code modal approval. The approval dialog shows the MCP tool name, operation, selected action or command when present, edit count, and affected files reported by the language provider.

Write-capable tools:

- `apply_code_action`
- `organize_imports`
- `fix_all`
- `format_document`
- `format_range`
- `format_on_type`
- `rename_symbol`

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
  "apply": true
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

Preview and apply a quick fix:

1. Call `code_actions` with a file and range.
2. Inspect `actionIndex`, `title`, `kind`, and `edit`.
3. Call `apply_code_action` with the selected `actionIndex` or `title`.

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
