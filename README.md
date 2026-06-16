# VS Code LSP MCP Bridge

Expose VS Code language intelligence as a local MCP server for AI coding tools.

This extension lets MCP clients ask the active VS Code workspace for semantic references, definitions, symbols, hover information, diagnostics, call hierarchy, type hierarchy, semantic tokens, code actions, formatting edits, and rename operations.

It is not tied to Codex and it is not tied to C#. It works with any language extension that implements VS Code's language-provider APIs. C# Dev Kit/Roslyn is a strong use case, but TypeScript, JavaScript, Python, Java, Go, Rust, PHP, and other languages can work when their VS Code language extension exposes the corresponding features.

The goal is simple: give AI coding tools a real semantic navigation path instead of forcing them to approximate code relationships with text search.

## Requirements

- VS Code `1.100.0` or newer.
- A language extension installed for the workspace you want to inspect.
- An MCP client that can connect to Streamable HTTP MCP servers.

End users do not need to install Node.js. Node/npm are development-time tools only.

## Quick Start

1. Install the extension from the Visual Studio Marketplace.
2. Open the workspace you want an AI coding tool to inspect.
3. Make sure the relevant language extension is loaded and working in VS Code.
4. For VS Code/GitHub Copilot, use the automatically registered `VS Code LSP MCP Bridge` server from VS Code's MCP UI.
5. For Codex, Claude Code, or another MCP client, run `LSP MCP Bridge: Copy MCP Client Config`.
6. Choose your client: Codex, VS Code/GitHub Copilot, Claude Code, or Generic HTTP MCP Client.
7. Run `LSP MCP Bridge: Open MCP Client Config File` if you want the extension to open a common target config file for you.
8. Paste the copied config into that client and restart or reload the client if needed.

The bridge starts automatically by default when VS Code finishes startup. You can also use:

- `LSP MCP Bridge: Start Server`
- `LSP MCP Bridge: Stop Server`
- `LSP MCP Bridge: Show Status`
- `LSP MCP Bridge: Use This Workspace`
- `LSP MCP Bridge: Copy MCP Client Config`
- `LSP MCP Bridge: Open MCP Client Config File`

For client-specific setup, run `LSP MCP Bridge: Copy MCP Client Config` and choose the target client. To avoid hunting for common config files, run `LSP MCP Bridge: Open MCP Client Config File`; it opens the selected file, creates missing files only after confirmation, and copies the matching snippet to the clipboard.

When several VS Code windows are open, the first bridge owns the stable local gateway endpoint. Other windows register behind that gateway, so your MCP client configuration can keep using the same URL. Run `LSP MCP Bridge: Use This Workspace` in the window you want new MCP sessions to inspect.

Default config file locations are listed in [docs/CLIENTS.md](docs/CLIENTS.md).

## VS Code Auto Registration

The extension registers an MCP server definition provider with VS Code. VS Code and GitHub Copilot can discover `VS Code LSP MCP Bridge` without a `.vscode/mcp.json` entry; when VS Code starts that server, the extension starts the local bridge if needed and supplies the bearer token header.

This auto-registration is only for VS Code's MCP host. Codex and Claude Code do not read VS Code extension-provided MCP server definitions, so they still need their own MCP configuration. Use `LSP MCP Bridge: Copy MCP Client Config` for those clients.

## Supported Languages

The bridge delegates to VS Code, so language support depends on the installed language extension and project state.

Examples:

- C# through C# Dev Kit/Roslyn
- TypeScript and JavaScript through the built-in TypeScript language service
- Python through the Python and Pylance extensions
- Java through Java language extensions
- Go through the Go extension
- Rust through rust-analyzer

Not every provider implements every VS Code language feature. For example, a language extension might support definitions and references but not type hierarchy or semantic tokens.

## What It Exposes

The bridge exposes VS Code's public language-provider command surface. It does not expose private language-server internals or arbitrary language-server protocol requests that VS Code does not publish through its extension API.

Read-only tools include:

- references, definitions, declarations, implementations, and type definitions
- hover, diagnostics, document highlights, document symbols, and workspace symbols
- call hierarchy and type hierarchy
- document links, semantic tokens, folding ranges, colors, inline values, code lens, and inlay hints
- completions, signature help, code actions, prepare rename, and rename preview

Write-capable tools include:

- apply code action
- organize imports
- fix all
- format document, format range, and format on type
- rename symbol

See [docs/TOOLS.md](docs/TOOLS.md) for the complete tool catalog.

## Security Model

The bridge is local-first and conservative by default:

- Binds to `127.0.0.1` by default.
- Uses a random bearer token stored in VS Code SecretStorage.
- Writes connection info to `~/.vscode-lsp-mcp-bridge/connection.json`.
- Refuses to start in untrusted workspaces.
- Exposes read-only tools by default.
- Keeps write tools disabled unless `vscodeLspMcpBridge.enableWriteTools` is enabled.
- Requires a VS Code modal approval before each write operation applies edits or executes a write-capable command.
- Does not expose shell execution.

See [docs/SECURITY.md](docs/SECURITY.md) for details.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `vscodeLspMcpBridge.autoStart` | `true` | Start the local bridge server when VS Code finishes startup. |
| `vscodeLspMcpBridge.host` | `127.0.0.1` | Host for the local bridge server. Keep this on localhost. |
| `vscodeLspMcpBridge.port` | `36521` | Stable local gateway port for MCP clients. Additional VS Code windows register behind this gateway instead of requiring client config changes. |
| `vscodeLspMcpBridge.connectionFile` | empty | Optional path for the connection file. Empty uses `~/.vscode-lsp-mcp-bridge/connection.json`. |
| `vscodeLspMcpBridge.enableWriteTools` | `false` | Enable MCP tools that can apply workspace edits. Each write still requires VS Code approval. |

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

Package a local VSIX:

```powershell
npm run package
```

See [docs/PUBLISHING.md](docs/PUBLISHING.md) for Marketplace publishing steps.
