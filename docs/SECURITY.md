# Security

This project gives external MCP clients access to language-intelligence data from the active VS Code workspace. Keep the default posture conservative.

## Defaults

- The bridge binds to `127.0.0.1`.
- A random bearer token is generated once and stored in VS Code SecretStorage.
- A separate secret authenticates worker registration; MCP client tokens cannot call gateway administration endpoints.
- Additional VS Code windows verify the gateway with a nonce/HMAC challenge, then register using that separate credential.
- The bridge refuses to start in untrusted workspaces.
- Read-only language tools are enabled.
- Tools that apply edits are disabled by default.
- Applying edits also requires a per-operation VS Code modal approval.
- No shell execution tool exists.
- File inputs and text edits are confined to open workspace folders.

## Connection File

The connection file includes the local gateway port, bearer token, and worker-registration credential. The bridge creates its directory and file with user-only permissions where the operating system supports POSIX modes. Keep it inside the current user's profile directory and treat it as sensitive.

Default path:

```text
~/.vscode-lsp-mcp-bridge/connection.json
```

Override with:

```json
"vscodeLspMcpBridge.connectionFile": "..."
```

MCP clients normally do not need the connection file. Use `LSP MCP Bridge: Copy MCP Client Config` to copy a gateway-based Streamable HTTP MCP configuration for your client.

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
