# GA - VS Code LSP MCP Bridge

Made by **Georgiana Alba (GA)**.

Expose VS Code language intelligence as a local MCP server for AI coding tools.

This extension exposes 46 MCP tools for semantic navigation, symbols, diagnostics, call and type hierarchies, document intelligence, completions, code actions, formatting, rename previews, and approved provider-backed document reads.

It is not tied to Codex and it is not tied to C#. It works with any language extension that implements VS Code's language-provider APIs. C# Dev Kit/Roslyn is a strong use case, but TypeScript, JavaScript, Python, Java, Go, Rust, PHP, and other languages can work when their VS Code language extension exposes the corresponding features.

The goal is simple: give AI coding tools a real semantic navigation path instead of forcing them to approximate code relationships with text search.

## Requirements

- VS Code `1.102.0` or newer.
- A language extension installed for the workspace you want to inspect.
- An MCP client that can connect to Streamable HTTP MCP servers.

End users do not need to install Node.js. Node/npm are development-time tools only.

## Quick Start

1. Install the extension from the Visual Studio Marketplace.
2. Open the workspace you want an AI coding tool to inspect.
3. Make sure the relevant language extension is loaded and working in VS Code.
4. For VS Code/GitHub Copilot, use the automatically registered `GA - VS Code LSP MCP Bridge` server from VS Code's MCP UI.
5. For Codex, Claude Code, or another external MCP client, run `GA - LSP MCP Bridge: Copy MCP Client Config`.
6. Choose your client: Codex, Claude Code, or Generic HTTP MCP Client. Choose VS Code/GitHub Copilot only if you want optional explicit JSON.
7. Run `GA - LSP MCP Bridge: Open MCP Client Config File` if you want the extension to open a common target config file for you.
8. Paste the copied config into that client and restart or reload the client if needed.

The bridge starts automatically by default when VS Code finishes startup. You can also use:

- `GA - LSP MCP Bridge: Open Quick Access`
- `GA - LSP MCP Bridge: Start Server`
- `GA - LSP MCP Bridge: Stop Server`
- `GA - LSP MCP Bridge: Show Status`
- `GA - LSP MCP Bridge: Route Gateway To This Workspace`
- `GA - LSP MCP Bridge: Enable Write Tools`
- `GA - LSP MCP Bridge: Disable Write Tools`
- `GA - LSP MCP Bridge: Copy MCP Client Config`
- `GA - LSP MCP Bridge: Open MCP Client Config File`
- `GA - LSP MCP Bridge: Install Codex Guidance`
- `GA - LSP MCP Bridge: Remove Codex Guidance`

The status-bar item opens the same quick-access menu and reports the connection state, active workspace, and whether write tools are enabled.

For client-specific setup, run `GA - LSP MCP Bridge: Copy MCP Client Config` and choose the target client. To avoid hunting for common config files, run `GA - LSP MCP Bridge: Open MCP Client Config File`; it opens the selected file, creates missing files only after confirmation, and copies the matching snippet to the clipboard.

For eager Codex use, run `GA - LSP MCP Bridge: Install Codex Guidance`. MCP server instructions alone are advisory; this consent-based command adds a managed block to Codex's active global `AGENTS.md`, preserving existing content, so semantic LSP routing happens before `rg` or other text search. Start a new Codex session afterward. The matching removal command removes only the managed block.

When several VS Code windows are open, VS Code/GitHub Copilot auto-registration uses the current window's own bridge endpoint automatically. Final users do not need to run a workspace-selection command for that path.

External clients such as Codex, Claude Code, Cursor, Windsurf, Cline, and Roo Code use the stable local gateway endpoint copied into their config. One bridge owns that gateway and other windows register behind it. New sessions target the selected window and then remain pinned there; changing the active window does not move an established session. Run `GA - LSP MCP Bridge: Route Gateway To This Workspace` only when you want future external-client sessions to start in a specific window.

Default config file locations are listed in [docs/CLIENTS.md](docs/CLIENTS.md).

## Supported Client Configuration

| Client | Built-in support |
| --- | --- |
| Codex | Copies a TOML Streamable HTTP configuration and can open/create `~/.codex/config.toml`. |
| VS Code / GitHub Copilot | Automatically registers the current window; can also copy explicit VS Code MCP JSON and open/create workspace `.vscode/mcp.json`. |
| Claude Code | Copies a ready-to-run `claude mcp add --transport http ...` command and can open/create workspace `.mcp.json` for project configuration. |
| Cursor | Uses the generic HTTP JSON format; can open/create user `~/.cursor/mcp.json` or workspace `.cursor/mcp.json`. |
| Windsurf / Cascade | Uses the generic HTTP JSON format and can open/create `~/.codeium/windsurf/mcp_config.json`. |
| Cline | Uses the generic HTTP JSON format and can open/create `~/.cline/mcp.json`. |
| Roo Code | Uses the generic HTTP JSON format and can open/create workspace `.roo/mcp.json`. |
| Other Streamable HTTP MCP clients | Copies generic JSON containing the stable gateway URL and bearer header. |

## VS Code Auto Registration

The extension registers an MCP server definition provider with VS Code. VS Code and GitHub Copilot can discover `GA - VS Code LSP MCP Bridge` without a `.vscode/mcp.json` entry; when VS Code starts that server, the extension starts the local bridge if needed and supplies the current window's endpoint and bearer token header.

This auto-registration is only for VS Code's MCP host. Codex and Claude Code do not read VS Code extension-provided MCP server definitions, so they still need their own MCP configuration. Use `GA - LSP MCP Bridge: Copy MCP Client Config` for those clients.

## Multiple VS Code Windows

Multi-window routing is built in:

- The first window owns the configured stable gateway port; later windows listen on isolated ephemeral ports and register as workers.
- VS Code/GitHub Copilot auto-registration uses each window's direct endpoint, so it naturally stays in that window.
- External clients use the stable gateway. Each new MCP session is assigned to the selected workspace and remains pinned to that owner for its lifetime.
- Unique explicit file paths, workspace URIs, or symbol-container hints can cross-route one tool call. Ambiguous or missing hints never silently move an established session.
- `GA - LSP MCP Bridge: Route Gateway To This Workspace` changes the target only for future external-client sessions.
- Registrations, routes, requests, responses, and idle sessions are bounded. Live session routes are not silently evicted.
- Workers refresh their registration and attempt credential-preserving gateway promotion only after repeated heartbeat failures.
- Protocol 3 signs internal requests over the method, path, body digest, routing headers, timestamp, and nonce; rejects replays; authenticates response status; and derives a different proxy key for each worker.
- Protocol 2 and protocol 3 deliberately fail closed when mixed. Reload all VS Code windows together when upgrading from extension 0.3.x.

## Supported Languages

The bridge delegates to VS Code, so language support depends on the installed language extension and project state.

Examples:

- C# through C# Dev Kit/Roslyn
- TypeScript and JavaScript through the built-in TypeScript language service
- Python through the Python and Pylance extensions
- Java through Java language extensions
- Go through the Go extension
- Rust through rust-analyzer
- PHP through a VS Code PHP language extension

Not every provider implements every VS Code language feature. For example, a language extension might support definitions and references but not type hierarchy or semantic tokens.

## Supported Features

The bridge exposes VS Code's public language-provider command surface. It does not expose private language-server internals or arbitrary language-server protocol requests that VS Code does not publish through its extension API.

Read-only tools include:

- references, definitions, declarations, implementations, and type definitions
- hover, diagnostics, document highlights, document symbols, and workspace symbols
- task-shaped named-symbol tools for callers, callees, references, and definitions
- bounded recursive call hierarchy and type hierarchy graphs
- combined symbol context and language-capability reporting
- filtered diagnostics with an optional bounded settling wait
- document links, semantic tokens, folding ranges, colors, inline values, code lens, and inlay hints
- rich completions with short-lived safe-apply IDs, signature help, code actions, prepare rename, and rename preview
- approved reads of bounded provider-backed virtual documents through opaque references

Mutation-capable tools include:

- apply a validated plain-text completion
- format document, format range, and format on type
- execute an explicitly requested command-only code action after separate approval

Generic provider `WorkspaceEdit` results—including edit-based code actions and rename—remain preview-only. VS Code's stable API cannot enumerate every hidden file, notebook, or snippet operation, so partially reconstructing and applying those edits would be unsafe.

File-aware tools accept workspace-relative paths, absolute paths inside an open workspace, or workspace URIs. Inputs and results use one-based positions. Named-symbol tools support container, file, and symbol-kind hints for disambiguation, and eligible navigation results include bounded `sourceLine` previews.

## Complete MCP Tool Catalog

All 46 registered tools are listed below. Actual results depend on the installed language extension implementing the corresponding VS Code provider.

### Guidance and capability discovery

| Tool | Supported capability |
| --- | --- |
| `semantic_navigation_guide` | Maps common code-navigation questions to the preferred semantic tool and explains when text search is only a fallback. |
| `language_capabilities` | Reports the stable provider invocation surfaces, bridge-level features, and stable-API limitations; an optional file adds its language ID and document version. |

### Navigation and symbols

| Tool | Supported capability |
| --- | --- |
| `find_callers_for_symbol` | Resolves a named symbol and returns semantic incoming callers and call sites. |
| `find_callees_for_symbol` | Resolves a named symbol and returns semantic outgoing callees and call sites. |
| `find_references_for_symbol` | Resolves a named symbol and returns semantic references with source-line previews when available. |
| `find_definition_for_symbol` | Resolves a named symbol and returns its semantic definitions. |
| `find_references` | Returns references for a known file position. |
| `go_to_definition` | Returns definitions for a known file position. |
| `go_to_declaration` | Returns declarations for a known file position. |
| `go_to_implementation` | Returns implementations for a known file position. |
| `go_to_type_definition` | Returns type definitions for a known file position. |
| `hover` | Returns bounded semantic hover contents and ranges. |
| `document_symbols` | Returns bounded hierarchical symbols for one document. |
| `workspace_symbols` | Searches provider-backed workspace symbols with bounded results. |
| `document_highlights` | Returns read, write, or text highlights for the symbol at a position. |

### Diagnostics, combined context, and hierarchies

| Tool | Supported capability |
| --- | --- |
| `diagnostics` | Returns file or workspace diagnostics with severity, tag, source, code, and message filters, optional bounded settling, and summary/truncation metadata. |
| `symbol_context` | Collects hover, definitions, type definitions, implementations, references, containing symbols, callers, and callees for a position without discarding successful categories when another provider fails. |
| `symbol_context_for_symbol` | Resolves a named symbol and returns the same combined semantic context. |
| `call_hierarchy_for_symbol` | Resolves a named symbol and builds a bounded incoming/outgoing call graph. |
| `call_hierarchy` | Builds a bounded incoming/outgoing call graph from a known position. |
| `type_hierarchy_for_symbol` | Resolves a named symbol and builds a bounded supertype/subtype graph. |
| `type_hierarchy` | Builds a bounded supertype/subtype graph from a known position. |

Hierarchy tools support bounded direction, depth, node, edge, child, and call-site controls. Public graph node IDs are random per response and do not reveal hidden provider URIs.

### Document and editor intelligence

| Tool | Supported capability |
| --- | --- |
| `selection_ranges` | Returns the provider's expanding semantic selection-range chain for a position. |
| `document_links` | Returns document links with bounded tooltips; unsafe targets are redacted and eligible virtual targets use opaque references. |
| `semantic_tokens` | Returns decoded document semantic tokens with token types and modifiers. |
| `range_semantic_tokens` | Returns decoded semantic tokens for a selected range. |
| `folding_ranges` | Returns provider-backed folding ranges and kinds. |
| `document_colors` | Returns detected color values and source ranges. |
| `color_presentations` | Returns textual color presentations and bounded text-edit previews. |
| `inline_values` | Returns debugger inline text, variable lookups, or evaluatable expressions for a range and stopped-location context. |
| `signature_help` | Returns signatures, parameters, documentation, and active signature/parameter information at a position. |
| `code_lens` | Returns code-lens ranges and bounded command summaries without executing them. |
| `inlay_hints` | Returns inlay hints for a document or range, including bounded labels, tooltips, locations, command summaries, padding, and text-edit previews. |

### Completions and source actions

| Tool | Supported capability |
| --- | --- |
| `completion` | Returns bounded completion metadata and issues short-lived safe-apply IDs only for validated plain-text edits. Snippets and provider commands remain preview-only. |
| `apply_completion` | Applies an unexpired completion snapshot to the same unchanged document after write enablement, containment checks, edit limits, and modal approval; it never runs the completion command. |
| `code_actions` | Lists bounded code actions, diagnostics, command summaries, and canonically safe text-edit previews. |
| `apply_code_action` | Executes a selected command-only action only when `executeCommand` is explicit and a separate warning is approved; provider edits remain preview-only. |
| `organize_imports` | Previews `source.organizeImports`; a command-only result can execute only when explicitly requested and approved. |
| `fix_all` | Previews `source.fixAll`; a command-only result can execute only when explicitly requested and approved. |

### Formatting and rename

| Tool | Supported capability |
| --- | --- |
| `format_document` | Previews document-formatting edits and optionally applies the validated edit set after approval. |
| `format_range` | Previews range-formatting edits and optionally applies the validated edit set after approval. |
| `format_on_type` | Previews on-type formatting for a position and trigger character and optionally applies it after approval. |
| `prepare_rename` | Checks whether the symbol at a position can be renamed and returns its range or placeholder. |
| `preview_rename` | Returns a bounded semantic rename preview without applying it. |
| `rename_symbol` | Compatibility rename endpoint that returns a semantic preview; `apply=true` is deliberately refused. |

### Provider-backed document access

| Tool | Supported capability |
| --- | --- |
| `read_virtual_document` | Reads a bounded range from an eligible provider-backed document through a previously issued opaque reference and explicit first-use approval. Arbitrary URIs are never accepted. |

## Safe Write and Preview Behavior

- Formatting, source-action, code-action, completion, and rename previews remain available without enabling mutation paths.
- Applying formatting or a plain-text completion requires `vscodeLspMcpBridge.enableWriteTools`, canonical workspace containment, bounded edit/file/insertion/replacement counts, non-overlapping valid ranges, and a VS Code modal approval.
- Approval dialogs show the operation, affected files, edit count, inserted bytes, and deleted/replaced characters.
- Approved text edits are revalidated against the same open document instance and version before application.
- Snippet completions, truncated completion edit sets, and completion commands cannot be applied by the bridge.
- Provider commands are excluded unless the caller explicitly requests command execution; they require a separate warning because their effects cannot be previewed or confined.
- Generic provider `WorkspaceEdit` objects, edit-based code actions, and semantic rename edits are always preview-only because the stable API cannot enumerate every hidden resource, notebook, or snippet operation safely.

## Additional Extension Features

- Streamable HTTP MCP at `/mcp`, plus an authenticated `POST /tool` endpoint for manual smoke tests and direct integrations.
- One-based public line/column values and source-line previews for eligible navigation results.
- Automatic startup, explicit lifecycle controls, connection/active-workspace status, and status-bar quick access.
- A built-in Get Started walkthrough for status, client configuration, workspace routing, config-file access, and write safety.
- The status dialog reports extension version, gateway/worker role, current and gateway endpoints, connection file, workspace-folder count, write state, active workspace, and registered workspace count when applicable.
- Host, port, and connection-file changes restart a running bridge; workspace-folder changes refresh its published routing context.
- Ready-to-copy configurations for Codex, VS Code/GitHub Copilot, Claude Code, and generic HTTP MCP clients.
- Assisted config-file opening for Codex, VS Code, Claude Code, Cursor, Windsurf, Cline, and Roo Code. Missing files are created only after confirmation; existing files are never silently rewritten.
- Multi-root, local, and remote-workspace URI support with bounded resolution and routing.
- A limited `/health` response that exposes role and workspace details only to an authorized caller.

## Stable API Limitations

The bridge reports these limitations through `language_capabilities` rather than pretending to support private or undocumented APIs:

- Linked-editing providers can be registered, but VS Code has no documented consumer command for querying another extension's linked-editing provider.
- Inline-completion providers can be registered, but VS Code has no documented consumer command for querying another extension's inline completions.
- The stable extension API does not expose moniker-provider consumption.
- Diagnostics come from VS Code's aggregated diagnostic collection rather than raw LSP pull-diagnostic requests.
- The public workspace-symbol command does not expose an explicit workspace-symbol resolve operation.

See [docs/TOOLS.md](docs/TOOLS.md) for input schemas, routing guidance, write behavior, and examples.

## Security Model

The bridge is local-first and conservative by default:

- Binds only to `127.0.0.1`.
- Uses a random bearer token stored in VS Code SecretStorage.
- Uses a separate gateway-registration credential that is never included in MCP client configuration.
- Writes connection info to `~/.vscode-lsp-mcp-bridge/connection.json` and requests directory/file modes `0700`/`0600` where the operating system supports POSIX permissions. Existing custom parent-directory permissions are not changed.
- Restricts file-based tool inputs and edits to the open workspace folders.
- Canonically checks local paths and rejects reported remote symlink traversal before reads or writes.
- Refuses to start in untrusted workspaces.
- Keeps read-only operations available by default while mutation paths remain disabled.
- Keeps write tools disabled unless `vscodeLspMcpBridge.enableWriteTools` is enabled.
- Requires a VS Code modal approval before each write operation applies edits or executes a write-capable command.
- Uses opaque, expiring references and an additional approval before opening provider-backed virtual documents.
- Signs internal multi-window traffic with replay-protected protocol-3 HMAC authentication and isolated per-worker keys; reusable bearer secrets are not sent in registration or proxy traffic.
- Bounds tool schemas, provider calls, traversal, routes, sessions, edit sizes, and normalized output.
- Does not send workspace data to a hosted service by itself; data is shared only with MCP clients the user configures and with installed VS Code language providers.
- Does not expose shell execution.

See [docs/SECURITY.md](docs/SECURITY.md) for details.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `vscodeLspMcpBridge.autoStart` | `true` | Start the local bridge server when VS Code finishes startup. |
| `vscodeLspMcpBridge.host` | `127.0.0.1` | Local bridge host. Only `127.0.0.1` is accepted. |
| `vscodeLspMcpBridge.port` | `36521` | Stable local gateway port for external MCP clients. VS Code/GitHub Copilot auto-registration uses the current window endpoint. |
| `vscodeLspMcpBridge.connectionFile` | empty | Optional path for the connection file. Empty uses `~/.vscode-lsp-mcp-bridge/connection.json`. |
| `vscodeLspMcpBridge.enableWriteTools` | `false` | Enable validated formatting/completion edits and explicitly requested provider commands. Every mutation still requires VS Code approval. |
| `vscodeLspMcpBridge.notificationDurationMs` | `5000` | How long passive status-bar notifications remain visible, in milliseconds. |

## Development

Install dependencies:

```powershell
npm install
```

Compile:

```powershell
npm run compile
```

Run the bounded core regression tests:

```powershell
npm test
```

Run the extension:

1. Open this folder in VS Code.
2. Press `F5`.
3. In the Extension Development Host, open a real project with language extensions installed.
4. Run `GA - LSP MCP Bridge: Show Status`.

Package a local VSIX:

```powershell
npm run package
```

See [docs/PUBLISHING.md](docs/PUBLISHING.md) for Marketplace publishing steps.
