# Tool Catalog

All positions use zero-based `line` and `character` values, matching the VS Code API.

## Position Tools

Input:

```json
{
  "file": "absolute/or/workspace/relative/path.cs",
  "line": 10,
  "character": 15
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
- `completion`
- `signature_help`
- `prepare_rename`
- `preview_rename`

## Document Tools

Input:

```json
{
  "file": "absolute/or/workspace/relative/path.cs"
}
```

Tools:

- `document_symbols`
- `code_lens`
- `inlay_hints`
- `code_actions`
- `format_document`

## Workspace Tools

Input:

```json
{
  "query": "AddNotWorkingValues"
}
```

Tools:

- `workspace_symbols`

## Diagnostics

Input:

```json
{
  "file": "optional/path.cs"
}
```

If `file` is omitted, diagnostics for all open/workspace-tracked documents are returned.

## Write Tools

`rename_symbol` can preview or apply:

```json
{
  "file": "path.cs",
  "line": 10,
  "character": 15,
  "newName": "NewSymbolName",
  "apply": false
}
```

`format_document` can preview or apply:

```json
{
  "file": "path.cs",
  "apply": false
}
```

Applying edits requires:

```json
"vscodeLspMcpBridge.enableWriteTools": true
```

