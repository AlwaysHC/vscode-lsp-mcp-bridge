# Tool Catalog

Tool inputs use one-based editor `line` and `column` values.

Tool results are compact for LLM use and use the same one-based editor `line` and `column` values.

```json
{
  "file": "D:\\MyProgs\\C#\\DigitalAGoGo\\Aquarius\\Backend\\Controllers\\AgendasController.cs",
  "line": 242,
  "column": 25,
  "endLine": 242,
  "endColumn": 44
}
```

Use `line` and `column` values in user-facing answers.

## Position Tools

Input:

```json
{
  "file": "absolute/or/workspace/relative/path.cs",
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
  "column": 15,
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
