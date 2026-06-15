# Publishing

## Checklist

1. Replace `publisher` in `package.json`.
2. Add a marketplace icon.
3. Add repository URL.
4. Confirm all marketplace text states that a localhost bridge is started.
5. Keep write tools disabled by default.
6. Confirm runtime dependencies are bundled into `dist/extension.js`.
7. Run a clean package build.

```powershell
npm install
npm run compile
npm run package
```

## Local VSIX Test

```powershell
code --install-extension .\vscode-lsp-mcp-bridge-0.0.1.vsix
```

Then open a C# workspace with C# Dev Kit installed and run:

```text
LSP MCP Bridge: Show Status
```

Then copy the direct Codex configuration:

```text
LSP MCP Bridge: Copy Codex MCP Config
```

The final user should not need to install Node.js. Node/npm are development-time tools only.

## Future Features

- Tool-level allowlist settings.
- Per-workspace trust prompt.
- Better result paging for huge reference sets.
- Tests using small TypeScript and C# sample projects.
- Optional VS Code Language Model Tools for VS Code agent mode.
