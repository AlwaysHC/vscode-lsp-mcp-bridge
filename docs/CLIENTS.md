# MCP Client Setup

Run `LSP MCP Bridge: Copy MCP Client Config` from the VS Code Command Palette and choose the client you want to configure. The command starts the bridge if needed, then copies a config snippet with the current endpoint and bearer token.

Default endpoint:

```text
http://127.0.0.1:36521/mcp
```

The token is generated locally and stored in VS Code SecretStorage. Treat copied snippets as sensitive.

## Configuration File Locations

Use these default locations when you paste the bridge settings manually:

| Client | Default configuration location | Notes |
| --- | --- | --- |
| Codex | `~/.codex/config.toml` (`%USERPROFILE%\.codex\config.toml` on Windows) | Paste the copied TOML into the main config file. If you use project-local Codex configuration, put the same block in `<project>/.codex/config.toml`. |
| VS Code / GitHub Copilot | Workspace: `<project>/.vscode/mcp.json`; user profile: open `MCP: Open User Configuration` | For the default VS Code profile, the user file is usually `%APPDATA%\Code\User\mcp.json` on Windows, `~/Library/Application Support/Code/User/mcp.json` on macOS, or `~/.config/Code/User/mcp.json` on Linux. |
| Claude Code | Default local scope: `~/.claude.json`; shared project scope: `<project>/.mcp.json` | The `claude mcp add` command writes to the right place. Use `--scope project` if you want the bridge entry in `.mcp.json`. |
| Cursor | User: `~/.cursor/mcp.json`; project: `<project>/.cursor/mcp.json` | Use the generic JSON shape unless Cursor asks for a different HTTP transport label. |
| Windsurf / Cascade | `~/.codeium/windsurf/mcp_config.json` (`%USERPROFILE%\.codeium\windsurf\mcp_config.json` on Windows) | Windsurf accepts `serverUrl` or `url` for remote HTTP MCPs. |
| Cline | CLI: `~/.cline/mcp.json`; IDE extension: open Cline's MCP Servers view, then Configure | The IDE extension opens its own MCP settings JSON; add the bridge under `mcpServers`. |
| Roo Code | Global: `mcp_settings.json` opened by `Edit Global MCP`; project: `<project>/.roo/mcp.json` | Project settings override global settings for matching server names. |

## Codex

Choose `Codex` in the picker. The copied TOML has this shape:

```toml
[mcp_servers.vscode_lsp]
url = "http://127.0.0.1:36521/mcp"
http_headers = { Authorization = "Bearer copied-token" }
```

Add it to `~/.codex/config.toml`, then restart Codex.

## VS Code / GitHub Copilot

Choose `VS Code / GitHub Copilot` in the picker. The copied JSON is intended for VS Code's MCP configuration file.

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

After saving the config, start or trust the server from VS Code's MCP UI when prompted.

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
- Keep the MCP endpoint on `127.0.0.1` unless you understand the security implications.
- If the port is already in use, change `vscodeLspMcpBridge.port` and copy a fresh client config.
