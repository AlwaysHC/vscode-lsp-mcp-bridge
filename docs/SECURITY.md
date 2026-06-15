# Security

This project gives external MCP clients access to language-intelligence data from the active VS Code workspace. Keep the default posture conservative.

## Defaults

- The bridge binds to `127.0.0.1`.
- A random bearer token is generated once and stored in VS Code SecretStorage.
- The bridge refuses to start in untrusted workspaces.
- Read-only language tools are enabled.
- Tools that apply edits are disabled by default.
- Applying edits also requires a per-operation VS Code modal approval.
- No shell execution tool exists.

## Connection File

The connection file includes the local port and bearer token. Keep it inside the current user's profile directory.

Default path:

```text
~/.vscode-lsp-mcp-bridge/connection.json
```

Override with:

```json
"vscodeLspMcpBridge.connectionFile": "..."
```

Codex normally does not need the connection file. Use `LSP MCP Bridge: Copy Codex MCP Config` to copy a direct Streamable HTTP MCP configuration.

## Write Tools

Write tools are intentionally gated by:

```json
"vscodeLspMcpBridge.enableWriteTools": false
```

Even when write tools are enabled, each operation that would apply edits or execute a write-capable code-action command asks the user to approve a VS Code modal dialog first. The dialog includes the MCP tool name, operation, selected action or command when present, edit count, and affected files reported by the language provider.

The first public release should probably keep this default and document write tools as experimental.

## Marketplace Review Notes

Be explicit in the marketplace README:

- The extension starts a localhost server.
- The extension writes a local token file.
- The extension shares workspace language metadata with configured MCP clients.
- The extension does not send data to a hosted service by itself.
