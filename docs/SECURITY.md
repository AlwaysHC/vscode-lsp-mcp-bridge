# Security

This project gives external MCP clients access to language-intelligence data from the active VS Code workspace. Keep the default posture conservative.

## Defaults

- The bridge binds to `127.0.0.1`.
- A random bearer token is generated once and stored in VS Code SecretStorage.
- The bridge refuses to start in untrusted workspaces.
- Read-only language tools are enabled.
- Tools that apply edits are disabled by default.
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

The first public release should probably keep this default and document write tools as experimental.

## Marketplace Review Notes

Be explicit in the marketplace README:

- The extension starts a localhost server.
- The extension writes a local token file.
- The extension shares workspace language metadata with configured MCP clients.
- The extension does not send data to a hosted service by itself.
