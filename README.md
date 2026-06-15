# VS Code LSP MCP Bridge

Expose VS Code language intelligence to MCP clients.

This extension lets an MCP client ask the active VS Code language providers for semantic navigation, symbols, hover information, diagnostics, hierarchy data, semantic tokens, links, colors, code actions, formatting, and rename operations. For C# projects, this means the bridge can reuse C# Dev Kit/Roslyn when it is already working in VS Code.

The goal is simple: give coding agents a real "Find All References" path instead of forcing them to approximate symbol relationships with text search.

## How It Works

```text
MCP client
  -> http://127.0.0.1:36521/mcp
    -> VS Code extension host
      -> VS Code language feature commands
        -> installed language provider such as C# Dev Kit / Roslyn
```

The VS Code extension hosts a Streamable HTTP MCP server directly. End users do not need to install Node.js separately to use the published extension.

## Current Tools

The bridge exposes VS Code's public language-provider command surface. It does not expose private Roslyn process internals or arbitrary language-server protocol requests that VS Code does not publish through its extension API.

Read-only tools:

- `find_references`
- `go_to_definition`
- `go_to_declaration`
- `go_to_implementation`
- `go_to_type_definition`
- `hover`
- `document_symbols`
- `workspace_symbols`
- `document_highlights`
- `diagnostics`
- `call_hierarchy_for_symbol`
- `call_hierarchy`
- `type_hierarchy_for_symbol`
- `type_hierarchy`
- `selection_ranges`
- `document_links`
- `semantic_tokens`
- `range_semantic_tokens`
- `folding_ranges`
- `document_colors`
- `color_presentations`
- `inline_values`
- `completion`
- `signature_help`
- `code_lens`
- `inlay_hints`
- `code_actions`
- `prepare_rename`
- `preview_rename`

Write-capable tools:

- `apply_code_action`
- `organize_imports`
- `fix_all`
- `format_document`
- `format_range`
- `format_on_type`
- `rename_symbol` with `apply: true`

Write behavior is disabled by default with `vscodeLspMcpBridge.enableWriteTools: false`. When enabled, each actual write still requires a VS Code modal approval showing the tool name and affected files.

## Development

Install dependencies:

```powershell
npm install
```

Compile:

```powershell
npm run compile
```

Run the extension:

1. Open this folder in VS Code.
2. Press `F5`.
3. In the Extension Development Host, open a real project with language extensions installed.
4. Run `LSP MCP Bridge: Show Status`.

## Codex Configuration

After starting the extension, run `LSP MCP Bridge: Copy Codex MCP Config` to copy a config block with the current endpoint and bearer token.

Generic shape:

```toml
[mcp_servers.vscode_lsp]
url = "http://127.0.0.1:36521/mcp"
http_headers = { Authorization = "Bearer copied-token" }
```

VS Code must be running with the target workspace open, and the bridge must be started.

## Security Defaults

- Binds to `127.0.0.1` by default.
- Uses a persistent random bearer token stored in VS Code SecretStorage.
- Writes connection info to `~/.vscode-lsp-mcp-bridge/connection.json`.
- Refuses to start in untrusted workspaces.
- Exposes read-only tools by default.
- Keeps rename and formatting application disabled unless explicitly enabled.
- Requires per-operation VS Code approval before applying write-tool edits.
- Does not expose shell execution.

See [docs/SECURITY.md](docs/SECURITY.md).

## Publishing Notes

Before publishing:

- Replace `publisher` in `package.json`.
- Add icon and marketplace metadata.
- Decide whether write tools should remain behind an explicit setting.
- Add integration tests with a small sample project.

See [docs/PUBLISHING.md](docs/PUBLISHING.md).
