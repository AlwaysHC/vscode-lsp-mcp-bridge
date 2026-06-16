# MCP Client Setup

Run `LSP MCP Bridge: Copy MCP Client Config` from the VS Code Command Palette and choose the client you want to configure. The command starts the bridge if needed, then copies a config snippet with the current endpoint and bearer token.

You can also run `LSP MCP Bridge: Open MCP Client Config File`. It opens a common MCP client config file, creates the file only after confirmation when it is missing, and copies the matching bridge snippet to the clipboard. It does not silently edit existing files.

For VS Code/GitHub Copilot, manual JSON is optional. The extension automatically contributes a `VS Code LSP MCP Bridge` MCP server definition to VS Code, and VS Code starts the bridge with the correct bearer token when you enable or start that server from the MCP UI.

Codex, Claude Code, Cursor, Windsurf, Cline, Roo Code, and other external clients do not read VS Code extension-provided MCP server definitions. Configure those clients with the copied snippet or command.

Default gateway endpoint:

```text
http://127.0.0.1:36521/mcp
```

Keep this endpoint in your MCP client config. When several VS Code windows are open, one bridge owns this stable gateway port and the other windows register behind it. Run `LSP MCP Bridge: Use This Workspace` in the VS Code window you want new MCP sessions to inspect.

The token is generated locally and stored in VS Code SecretStorage. Treat copied snippets as sensitive.

## Configuration File Locations

Use these default locations when you paste the bridge settings manually:

| Client | Default configuration location | Notes |
| --- | --- | --- |
| Codex | `~/.codex/config.toml` (`%USERPROFILE%\.codex\config.toml` on Windows) | Paste the copied TOML into the main config file. If you use project-local Codex configuration, put the same block in `<project>/.codex/config.toml`. |
| VS Code / GitHub Copilot | Auto-registered by the extension; optional manual config in workspace `<project>/.vscode/mcp.json` or user profile `MCP: Open User Configuration` | Manual JSON is useful if you want an explicit config file. For the default VS Code profile, the user file is usually `%APPDATA%\Code\User\mcp.json` on Windows, `~/Library/Application Support/Code/User/mcp.json` on macOS, or `~/.config/Code/User/mcp.json` on Linux. |
| Claude Code | Default local scope: `~/.claude.json`; shared project scope: `<project>/.mcp.json` | The `claude mcp add` command writes to the right place. Use `--scope project` if you want the bridge entry in `.mcp.json`. |
| Cursor | User: `~/.cursor/mcp.json`; project: `<project>/.cursor/mcp.json` | Use the generic JSON shape unless Cursor asks for a different HTTP transport label. |
| Windsurf / Cascade | `~/.codeium/windsurf/mcp_config.json` (`%USERPROFILE%\.codeium\windsurf\mcp_config.json` on Windows) | Windsurf accepts `serverUrl` or `url` for remote HTTP MCPs. |
| Cline | CLI: `~/.cline/mcp.json`; IDE extension: open Cline's MCP Servers view, then Configure | The IDE extension opens its own MCP settings JSON; add the bridge under `mcpServers`. |
| Roo Code | Global: `mcp_settings.json` opened by `Edit Global MCP`; project: `<project>/.roo/mcp.json` | Project settings override global settings for matching server names. |

## Files Opened By The Extension

`LSP MCP Bridge: Open MCP Client Config File` can open these common targets:

| Picker option | File opened | Snippet copied |
| --- | --- | --- |
| Codex global config | `~/.codex/config.toml` | Codex TOML |
| VS Code workspace MCP config | `<workspace>/.vscode/mcp.json` | VS Code/GitHub Copilot JSON |
| Claude Code project config | `<workspace>/.mcp.json` | Generic HTTP MCP JSON |
| Cursor user config | `~/.cursor/mcp.json` | Generic HTTP MCP JSON |
| Cursor workspace config | `<workspace>/.cursor/mcp.json` | Generic HTTP MCP JSON |
| Windsurf user config | `~/.codeium/windsurf/mcp_config.json` | Generic HTTP MCP JSON |
| Cline user config | `~/.cline/mcp.json` | Generic HTTP MCP JSON |
| Roo Code workspace config | `<workspace>/.roo/mcp.json` | Generic HTTP MCP JSON |

Some clients expose their own preferred command or UI. For VS Code user-level MCP configuration, `MCP: Open User Configuration` remains the most reliable path because it respects the current VS Code profile. For Claude Code local configuration, the copied `claude mcp add ...` command is usually better than editing `~/.claude.json` by hand.

## Codex

Choose `Codex` in the picker. The copied TOML has this shape:

```toml
[mcp_servers.vscode_lsp]
url = "http://127.0.0.1:36521/mcp"
http_headers = { Authorization = "Bearer copied-token" }
```

Add it to `~/.codex/config.toml`, then restart Codex.

## VS Code / GitHub Copilot

The extension automatically registers `VS Code LSP MCP Bridge` as a VS Code MCP server definition provider. You can start, trust, enable, disable, or inspect it from VS Code's MCP UI without adding a `.vscode/mcp.json` entry. When VS Code starts the server, the extension starts the local bridge if needed and sends the current bearer token in the `Authorization` header.

Choose `VS Code / GitHub Copilot` in the picker only if you prefer explicit MCP JSON. The copied JSON is intended for VS Code's MCP configuration file.

VS Code supports MCP configuration in:

- workspace `<project>/.vscode/mcp.json`
- user profile MCP configuration opened by `MCP: Open User Configuration`

The copied JSON has this shape:

```json
{
  "servers": {
    "vscode_lsp": {
      "type": "http",
      "url": "http://127.0.0.1:36521/mcp",
      "requestInit": {
        "headers": {
          "Authorization": "Bearer copied-token"
        }
      }
    }
  }
}
```

After saving manual config, start or trust the server from VS Code's MCP UI when prompted.

References:

- VS Code MCP servers: https://code.visualstudio.com/docs/agent-customization/mcp-servers
- GitHub Copilot MCP in IDEs: https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/extend-copilot-chat-with-mcp

## Claude Code

Choose `Claude Code` in the picker. The copied command has this shape:

```powershell
claude mcp add --transport http vscode_lsp http://127.0.0.1:36521/mcp --header "Authorization: Bearer copied-token"
```

Run it from the project you want Claude Code to configure. By default, Claude Code stores local MCP entries in `~/.claude.json` under the current project path. Add `--scope project` if you want a shared `<project>/.mcp.json` entry instead. Use `/mcp` inside Claude Code if you need to inspect or authenticate configured MCP servers.

Reference:

- Claude Code MCP docs: https://code.claude.com/docs/en/mcp

## Cursor, Windsurf, Cline, Roo Code, And Other MCP Clients

Choose `Generic HTTP MCP Client` in the picker if your client supports HTTP or Streamable HTTP MCP servers but does not match one of the named formats.

The copied JSON has this shape:

```json
{
  "mcpServers": {
    "vscode_lsp": {
      "type": "http",
      "url": "http://127.0.0.1:36521/mcp",
      "headers": {
        "Authorization": "Bearer copied-token"
      }
    }
  }
}
```

Paste this JSON under `mcpServers` in the client's MCP config file. Different clients use different field names for HTTP headers. If your client does not accept `headers`, look for equivalent fields such as `requestInit.headers`, `http_headers`, or command-line `--header`.

Client-specific adjustments:

- Cursor: use `~/.cursor/mcp.json` for a user-wide entry or `<project>/.cursor/mcp.json` for one workspace.
- Windsurf / Cascade: paste into `~/.codeium/windsurf/mcp_config.json`; if needed, rename `url` to `serverUrl`.
- Cline: for the CLI, paste into `~/.cline/mcp.json`; for the IDE extension, open the MCP Servers view and use the Configure tab.
- Roo Code: paste into the global `mcp_settings.json` from `Edit Global MCP` or into `<project>/.roo/mcp.json`; for Streamable HTTP, set `"type": "streamable-http"` if Roo rejects `"http"`.

References:

- Cursor MCP docs: https://docs.cursor.com/en/context/mcp
- Windsurf / Cascade MCP docs: https://docs.windsurf.com/windsurf/cascade/mcp
- Cline MCP docs: https://docs.cline.bot/mcp/mcp-overview
- Roo Code MCP docs: https://docs.roocode.com/features/mcp/using-mcp-in-roo

## Test Prompt

After configuring a client, open a project in VS Code and ask:

```text
Use the vscode_lsp MCP tools to find references for a symbol in this workspace. Prefer semantic tools over text search.
```

For a stronger test, ask for a call hierarchy:

```text
Using only vscode_lsp tools, show the incoming calls for MyClass.MyMethod and include file and line for each caller.
```

## Troubleshooting

- VS Code must be running with the target workspace open.
- The workspace must be trusted.
- The relevant language extension must finish loading before semantic results are complete.
- If the auto-registered VS Code MCP server does not appear, reload VS Code and confirm you are running VS Code `1.100.0` or newer.
- Keep the MCP endpoint on `127.0.0.1` unless you understand the security implications.
- If several VS Code windows are open, run `LSP MCP Bridge: Use This Workspace` in the window you want new MCP sessions to inspect.
- If another non-bridge process is using the gateway port, stop that process or change `vscodeLspMcpBridge.port` once and copy a fresh client config.
