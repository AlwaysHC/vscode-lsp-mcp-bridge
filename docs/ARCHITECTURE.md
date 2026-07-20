# Architecture

## Components

```text
VS Code extension
  src/extension.ts
  src/bridgeHttpServer.ts
  src/languageTools.ts
  src/languageToolCore.ts
  src/languageTools/
    runtime.ts
    diagnostics.ts
    symbols.ts
    symbolContext.ts
    hierarchies.ts
    documentFeatures.ts
    completions.ts
    virtualDocuments.ts
    writeSafety.ts
    writeTools.ts
  src/mcp/createLanguageMcpServer.ts
  src/mcp/toolDefinitions.ts

Shared protocol
  src/shared/bridgeAuth.ts
  src/shared/protocol.ts
  src/shared/paths.ts
```

## VS Code Extension

The extension starts a localhost HTTP server. Each running bridge exposes a Streamable HTTP MCP endpoint at `/mcp`.

VS Code/GitHub Copilot auto-registration receives the current window's own endpoint. This means each VS Code window can use its own language context automatically without asking the user to select a workspace.

External MCP clients receive the stable gateway endpoint in copied config snippets. One VS Code window owns the configured gateway port. Later windows discover and verify it, start localhost worker endpoints, and register with that gateway. The gateway routes each new external-client MCP session to the selected workspace and pins that session to its initializing window. Unique explicit file/URI hints can cross-route an individual tool call; ambiguous hints never follow later active-window changes.

Workers verify initial gateway discovery with a nonce/HMAC challenge. Every later gateway-administration request is independently HMAC signed over its method, path, exact body digest, routing headers, timestamp, and random nonce; the registration secret itself is never placed in an HTTP authorization header. The gateway returns a proof bound to the request nonce and actual HTTP status, and bounded replay caches reject duplicate or stale messages.

Registration payloads contain no bearer credential. Instead, both sides derive an isolated proxy key from the registration secret and workspace ID. Gateway-to-worker MCP and `/tool` traffic is signed with that key, and worker responses are authenticated before the gateway creates a session route or forwards data. Only the gateway writes the connection file. Verified workers retain the shared credentials in profile SecretStorage, and bounded failover preserves them when a worker becomes the gateway.

For manual smoke tests, the bridge also keeps a `POST /tool` endpoint that dispatches to `runLanguageTool`. It uses the same strict schemas, authorization, routing, normalization, and output cap as MCP calls.

The extension deliberately uses VS Code's generic language feature commands, such as:

- `vscode.executeReferenceProvider`
- `vscode.executeDefinitionProvider`
- `vscode.executeImplementationProvider`
- `vscode.executeWorkspaceSymbolProvider`
- `vscode.prepareCallHierarchy`
- `vscode.executeDocumentRenameProvider`

This means it can work with any language provider that implements those VS Code APIs, not only C#.

`src/languageTools.ts` is intentionally only the dispatcher. Provider invocation, normalization, hierarchy traversal, diagnostics, opaque grants, and write validation live in focused modules so their limits and security boundaries can be reviewed independently.

## MCP Server

The MCP server runs inside the VS Code extension host. It registers tools from `src/mcp/toolDefinitions.ts` through `src/mcp/createLanguageMcpServer.ts`, then serves them through `StreamableHTTPServerTransport`.

The published VSIX bundles runtime dependencies into `dist/extension.js`. Final users do not need Node.js or `node_modules`.

External clients connect to the stable gateway endpoint:

```toml
[mcp_servers.vscode_lsp]
url = "http://127.0.0.1:36521/mcp"
http_headers = { Authorization = "Bearer copied-token" }
```

This avoids requiring final users to install Node.js or run a separate MCP wrapper process. Port `36521` is the default gateway. If another VS Code window already owns it, the new window registers as a worker behind the gateway instead of changing external MCP client URLs. VS Code/GitHub Copilot auto-registration bypasses this shared routing choice by using the current window endpoint directly.

## Connection File

By default:

```text
~/.vscode-lsp-mcp-bridge/connection.json
```

The file contains:

```json
{
  "version": 3,
  "host": "127.0.0.1",
  "port": 36521,
  "token": "random-token",
  "registrationToken": "separate-random-token",
  "workspaceFolders": ["..."],
  "workspaceFolderUris": ["file:///..."],
  "createdAt": "2026-06-14T00:00:00.000Z"
}
```

Clients should treat this file as sensitive because it contains the bearer token and the separate worker-registration credential for the local bridge. MCP client snippets include only the bearer token.

Protocol 3 replaces bearer-authenticated internal registration and proxy calls with signed messages. A protocol-3 process preserves credentials from a legacy protocol-2 file when it can safely take ownership of a free gateway port, but it refuses mixed-version registration while an older gateway is still running. Reload or close older extension windows together during this upgrade.

## Limitations

- The bridge can expose only language features that VS Code exposes through stable APIs.
- Some language extensions may return partial data until their project model has finished loading.
- C# Dev Kit/Roslyn behavior depends on the solution state inside VS Code.
- MCP clients cannot use these tools if VS Code is not running with the target workspace open.
