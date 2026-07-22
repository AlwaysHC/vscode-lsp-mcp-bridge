# Security

This project gives external MCP clients access to language-intelligence data from the active VS Code workspace. Keep the default posture conservative.

## Defaults

- The bridge binds to `127.0.0.1`.
- A random bearer token is generated once and stored in VS Code SecretStorage.
- A separate secret signs every gateway-administration request; the secret is never sent as an HTTP bearer credential, and MCP client tokens cannot call gateway administration endpoints.
- Additional VS Code windows verify initial gateway discovery with a nonce/HMAC challenge. Registration and heartbeat requests are body-bound, timestamped, nonce-protected HMAC messages, and gateway responses prove their identity while binding the HTTP status.
- Gateway-to-worker traffic uses a distinct key derived for that workspace. Requests and responses are authenticated, replay protected, and never expose the shared MCP bearer token to worker registration or internal proxy endpoints.
- The bridge refuses to start in untrusted workspaces.
- Read-only language tools are enabled.
- Tools that apply edits are disabled by default.
- Applying edits also requires a per-operation VS Code modal approval.
- Generic provider `WorkspaceEdit` results are preview-only; only bridge-constructed plain `TextEdit` sets can be applied.
- No shell execution tool exists.
- File inputs and text edits are confined to canonical open-workspace paths, including local realpath and reported remote-symlink checks.
- Provider-backed virtual documents use opaque expiring references, block sensitive schemes, require a workspace routing anchor and first-use approval, and return bounded text.
- Provider calls, hierarchy traversal, sessions, inputs, and normalized results have explicit time/size/count limits.

## Connection File

The connection file includes the local gateway port, bearer token, and worker-registration credential. The bridge creates its dedicated default directory and file with user-only permissions where the operating system supports POSIX modes. It does not change permissions on an existing custom parent directory. Keep the file inside the current user's profile directory and treat it as sensitive.

Default path:

```text
~/.vscode-lsp-mcp-bridge/connection.json
```

Override with:

```json
"vscodeLspMcpBridge.connectionFile": "..."
```

MCP clients normally do not need the connection file. Use `LSP MCP Bridge: Copy MCP Client Config` to copy a gateway-based Streamable HTTP MCP configuration for your client.

The optional Codex guidance command modifies the active global `~/.codex/AGENTS.md` or `AGENTS.override.md` only after showing the exact target and managed content in a modal confirmation. Existing content is preserved. The removal command deletes only the marker-delimited block owned by this extension and also requires confirmation.

Claude Code guidance uses the same consent and marker-delimited update model for `~/.claude/CLAUDE.md`, with a client-specific marker so it cannot remove the Codex block. Copilot guidance is packaged as a declarative VS Code `chatInstructions` contribution and does not modify user or workspace instruction files.

## Write Tools

Write tools are intentionally gated by:

```json
"vscodeLspMcpBridge.enableWriteTools": false
```

Even when write tools are enabled, each operation that applies edits or executes a provider command asks the user to approve a VS Code modal dialog first. Formatting and completion edits are insertion/replacement/range/overlap checked, restricted to canonical workspace files, and revalidated against the same open document instance and version after the modal. The dialog reports inserted bytes and deleted/replaced characters. Commands require a separate warning because extension-defined effects cannot be previewed or confined.

Provider-returned `WorkspaceEdit` objects—including rename and edit-based code actions—are never applied by the bridge. VS Code's stable public API cannot enumerate every resource, notebook, or snippet operation, so rebuilding only visible text entries could apply an unsafe partial operation.

## Multiple VS Code Windows

The gateway pins each MCP session to the window that initialized it. An established session crosses to another worker only for a unique explicit file or symbol-routing hint; ambiguous hints stay with the owner. Live routes are never silently evicted, and idle routes expire with the session timeout.

Workers authenticate initial gateway discovery with a nonce/HMAC challenge, then authenticate every registration and heartbeat exchange independently. Internal requests bind the method, path, body digest, routing headers, timestamp, and random nonce; authenticated responses bind the request nonce and actual HTTP status. The gateway derives an isolated proxy key for each worker, so registration payloads and internal proxy requests do not carry the shared MCP bearer token. Replay caches are bounded and short lived.

Workers adopt verified shared credentials into their profile SecretStorage and do not write the gateway-owned connection file. Failover waits for repeated authenticated heartbeat failures, preserves credentials so existing external-client configurations continue to work, and cannot restart after an explicit stop or extension deactivation.

## Marketplace Review Notes

Be explicit in the marketplace README:

- The extension starts a localhost server.
- The extension writes a local token file.
- The extension shares workspace language metadata with configured MCP clients.
- The extension does not send data to a hosted service by itself.
