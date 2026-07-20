# Architecture

## Components

```text
VS Code extension
  src/extension.ts
  src/bridgeHttpServer.ts
  src/languageTools.ts
  src/mcp/createLanguageMcpServer.ts
  src/mcp/toolDefinitions.ts

Shared protocol
  src/shared/protocol.ts
  src/shared/paths.ts
```

## VS Code Extension

The extension starts a localhost HTTP server. Each running bridge exposes a Streamable HTTP MCP endpoint at `/mcp`.

VS Code/GitHub Copilot auto-registration receives the current window's own endpoint. This means each VS Code window can use its own language context automatically without asking the user to select a workspace.

External MCP clients receive the stable gateway endpoint in copied config snippets. The first VS Code window to start the bridge owns the configured gateway port. Later VS Code windows start localhost worker endpoints and register them with that gateway. The gateway routes new external-client MCP sessions to the active workspace, so external client configuration can keep using one stable URL.

Before sending registration credentials, a worker verifies the gateway with a nonce/HMAC challenge using the separate registration secret from the protected connection file.

For manual smoke tests, the bridge also keeps a debug `POST /tool` endpoint that dispatches directly to `runLanguageTool` and returns normalized JSON.

The extension deliberately uses VS Code's generic language feature commands, such as:

- `vscode.executeReferenceProvider`
- `vscode.executeDefinitionProvider`
- `vscode.executeImplementationProvider`
- `vscode.executeWorkspaceSymbolProvider`
- `vscode.prepareCallHierarchy`
- `vscode.executeDocumentRenameProvider`

This means it can work with any language provider that implements those VS Code APIs, not only C#.

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
  "version": 2,
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

## Limitations

- The bridge can expose only language features that VS Code exposes through stable APIs.
- Some language extensions may return partial data until their project model has finished loading.
- C# Dev Kit/Roslyn behavior depends on the solution state inside VS Code.
- MCP clients cannot use these tools if VS Code is not running with the target workspace open.
