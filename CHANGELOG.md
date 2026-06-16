# Changelog

## 0.2.2

- Fixes external-client multi-window routing so existing MCP sessions execute language tools against the workspace that owns the requested file path.

## 0.2.0

- Adds task-shaped semantic navigation tools (`find_callers_for_symbol`, `find_callees_for_symbol`, `find_references_for_symbol`, and `find_definition_for_symbol`) so agents can answer named-symbol questions without starting from text search.
- Adds `semantic_navigation_guide` and stronger MCP instructions to steer agents toward VS Code semantic tools before `rg`/`grep` for callers, references, definitions, and hierarchy requests.

## 0.1.6

- Registers an MCP server definition provider so VS Code/GitHub Copilot can discover the bridge without manual `mcp.json` setup.
- Uses the current VS Code window endpoint for auto-registered VS Code/GitHub Copilot MCP servers, so multiple windows follow their own context automatically.
- Documents that VS Code auto-registration does not configure Codex, Claude Code, or other external MCP clients.
- Fixes routed MCP sessions for secondary VS Code windows by forwarding follow-up `POST` request bodies through the gateway.
- Renames the workspace-routing command to `LSP MCP Bridge: Route Gateway To This Workspace` to clarify that it is only needed for external clients using the shared gateway.

## 0.1.5

- Removes the Marketplace Preview flag from the extension manifest.

## 0.1.4

- Shows the extension version in the bridge status message.

## 0.1.3

- Adds `sourceLine` previews to semantic location-list tools, including references and definitions, so clients can summarize matches without extra text search.
- Updates MCP tool guidance and documentation to prefer returned source context in user-facing answers.

## 0.1.2

- Keeps MCP client configuration stable by routing additional VS Code windows through the first local gateway endpoint.
- Adds a gateway workspace-routing command to route new external-client MCP sessions to the current VS Code workspace.
- Updates multi-window setup, security, architecture, and publishing documentation for the gateway/worker model.

## 0.1.1

- Adds client-specific MCP configuration file locations to the setup documentation.
- Documents the default configuration paths for Codex, VS Code/GitHub Copilot, Claude Code, Cursor, Windsurf/Cascade, Cline, and Roo Code.
- Replaces the README clients-doc link with command-based setup guidance.

## 0.1.0

- Adds a Streamable HTTP MCP server hosted inside the VS Code extension host.
- Exposes VS Code language-provider tools for semantic navigation, symbols, hover, diagnostics, call hierarchy, type hierarchy, completions, signature help, semantic tokens, code lens, inlay hints, links, colors, folding ranges, and code actions.
- Adds write-capable tools for code actions, organize imports, fix all, formatting, and rename.
- Keeps write tools disabled by default with `vscodeLspMcpBridge.enableWriteTools`.
- Adds a per-operation VS Code approval prompt before applying edits or executing write-capable commands.
- Adds a Command Palette workflow for status checks and copying MCP client configuration for Codex, VS Code/GitHub Copilot, Claude Code, or generic HTTP MCP clients.
- Documents that language support comes from installed VS Code language providers, not from a C#-only implementation.
- Adds Marketplace metadata, icon, and packaging documentation.
