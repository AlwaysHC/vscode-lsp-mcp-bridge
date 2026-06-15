# Publishing

This project is prepared for packaging and Marketplace publishing with `@vscode/vsce`.

## Publisher Identity

The Marketplace publisher display name can be `Georgiana Alba`, but `package.json.publisher` must be the publisher identifier, not the display name.

Current manifest value:

```json
"publisher": "georgiana-alba"
```

Before publishing, confirm that the publisher identifier created at the Visual Studio Marketplace publisher management page is exactly `georgiana-alba`. If the identifier differs, update `package.json` before packaging or publishing.

## Pre-Publish Checklist

1. Confirm `package.json.publisher` matches the Marketplace publisher identifier.
2. Confirm `package.json.repository`, `homepage`, and `bugs.url` point to the public repository.
3. Confirm `resources/icon.png` exists and is a PNG of at least 128x128 pixels.
4. Confirm README states that the extension starts a localhost MCP server.
5. Confirm write tools remain disabled by default and require a VS Code approval prompt.
6. Confirm dependencies are bundled into `dist/extension.js`.
7. Run a clean compile and VSIX package build.
8. Install the VSIX into a fresh Extension Development Host or another VS Code profile.

## Build And Package

```powershell
npm install
npm run compile
npm run package
```

Expected output:

```text
vscode-lsp-mcp-bridge-0.1.1.vsix
```

## Local VSIX Test

```powershell
code --install-extension .\vscode-lsp-mcp-bridge-0.1.1.vsix
```

Then:

1. Open a workspace with a language provider installed, for example C# Dev Kit for C#, Pylance for Python, or the built-in TypeScript language service.
2. Run `LSP MCP Bridge: Show Status`.
3. Confirm the endpoint is `http://127.0.0.1:36521/mcp` unless settings were changed.
4. Run `LSP MCP Bridge: Copy MCP Client Config`.
5. Choose at least one client format and confirm a snippet is copied.
6. Add the copied block to that client and restart or reload the client if needed.
7. Ask a semantic question such as:

```text
Using only vscode_lsp tools, show the incoming calls for MyClass.MyMethod and include file/line for each caller.
```

## Publish

Log in once:

```powershell
npx vsce login georgiana-alba
```

Publish:

```powershell
npm run publish
```

Or package locally and upload the VSIX manually from the Visual Studio Marketplace publisher management page.

The official VS Code publishing docs currently recommend Microsoft Entra ID based automated publishing for pipelines. Global Azure DevOps PATs are retired on December 1, 2026, so avoid building new automation around long-lived global PATs.

## User Install Notes

End users should install only the published VS Code extension. They do not need Node.js, npm, or this repository.

After installation, the smooth path is:

1. Open their project in VS Code.
2. Confirm their normal language extension works.
3. Run `LSP MCP Bridge: Copy MCP Client Config`.
4. Paste the copied MCP config into their MCP client.

## Release Hygiene

- Increment `package.json.version` for every publish.
- Update `CHANGELOG.md`.
- Run `npm run compile`.
- Run `npm run package`.
- Install and smoke-test the generated VSIX.
- Avoid SVG images in `package.json`, README, and CHANGELOG.
