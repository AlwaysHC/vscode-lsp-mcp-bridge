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

The extension starts a localhost HTTP server. The public integration endpoint is a Streamable HTTP MCP endpoint at `/mcp`.

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

Clients connect directly:

```toml
[mcp_servers.vscode_lsp]
url = "http://127.0.0.1:36521/mcp"
http_headers = { Authorization = "Bearer copied-token" }
```

This avoids requiring final users to install Node.js or run a separate MCP wrapper process.

## Connection File

By default:

```text
~/.vscode-lsp-mcp-bridge/connection.json
```

The file contains:

```json
{
  "version": 1,
  "host": "127.0.0.1",
  "port": 36521,
  "token": "random-token",
  "workspaceFolders": ["..."],
  "createdAt": "2026-06-14T00:00:00.000Z"
}
```

Clients should treat this file as sensitive because it contains the bearer token for the local bridge.

## Limitations

- The bridge can expose only language features that VS Code exposes through stable APIs.
- Some language extensions may return partial data until their project model has finished loading.
- C# Dev Kit/Roslyn behavior depends on the solution state inside VS Code.
- MCP clients cannot use these tools if VS Code is not running with the target workspace open.
