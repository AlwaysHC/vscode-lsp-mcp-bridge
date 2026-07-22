# Changelog

## 0.4.3 - 2026-07-22

- Adds consent-based install/remove commands for durable global Codex guidance that requires semantic LSP routing before `rg` or other text search, while preserving existing instructions.
- Tightens the MCP decision prefix to request `semantic_navigation_guide` as the first coding-task tool action.

## 0.4.2 - 2026-07-22

- Makes proactive LSP tool use explicit in the first 512 characters of the MCP server instructions so Codex does not require users to say "use LSP".

## 0.4.0 - 2026-07-20

- Splits the language-tool dispatcher into focused diagnostics, symbols, hierarchy, document-feature, completion, virtual-document, and write-safety modules.
- Adds filtered/settled diagnostics, combined symbol context, bounded recursive call/type graphs, richer completion snapshots, selection ranges, and capability reporting.
- Adds opaque, expiring references for provider-backed virtual documents with scheme restrictions, routing anchors, size limits, timeouts, and first-use approval.
- Pins MCP sessions to their initializing VS Code window, makes cross-window hints unique-only, handles URI anchors, bounds route capacity, and preserves gateway credentials during multi-profile failover.
- Upgrades multi-window transport to protocol 3 with replay-protected, body-bound HMAC requests, status-bound response proofs, isolated per-worker proxy keys, and no bearer secrets in registration or internal proxy traffic.
- Applies only validated formatting and plain-text completion edits with canonical workspace containment, overlap/insertion/replacement limits, document-instance/version checks, and modal approval.
- Keeps generic provider `WorkspaceEdit` results preview-only because stable VS Code APIs cannot enumerate hidden file, notebook, or snippet operations safely; provider commands require a separate explicit approval.
- Bounds provider calls and normalized output, validates direct `/tool` inputs with the same strict schemas as MCP, fixes named-symbol false matches, and removes all known npm audit findings.
- Raises the minimum VS Code version to 1.102, the first declared baseline used by the extension's MCP server-definition API.

## 0.3.0 - 2026-07-20

- Separates MCP client authorization from gateway worker registration and verifies gateways with a nonce/HMAC challenge.
- Restricts bridge listeners to loopback, protects connection-file permissions, and bounds request, response, workspace, and session resources.
- Confines file tools and applied edits to open workspace folders while preserving multi-root and remote-workspace URIs.
- Excludes unpreviewable resource operations from workspace edits and avoids executing code-action commands after failed edits.
- Fixes empty MCP results, code-action discrimination, live configuration refresh, and protocol/version consistency.

## 0.2.8

- Adds configurable timed status bar notifications for passive extension feedback.

## 0.2.7

- Refreshes the write-tools tooltip from VS Code events instead of polling.

## 0.2.6

- Keeps write-tools status and permission checks tied to the global setting across VS Code windows.
- Refreshes the status bar tooltip when another window changes the write-tools setting.

## 0.2.5

- Makes the write-tools setting global instead of workspace-specific.

## 0.2.4

- Adds LSP MCP Bridge status bar quick access with server, write-tools, and active-workspace hover status.
- Adds quick-access commands to enable or disable write tools without manually editing VS Code settings.
- Shows write-tools state in the bridge status dialog.

## 0.2.3

- Enhance symbol query handling and improve document symbol retrieval

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
