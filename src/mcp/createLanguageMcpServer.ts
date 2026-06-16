import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runLanguageTool } from "../languageTools.js";
import { toolDefinitions } from "./toolDefinitions.js";

export function createLanguageMcpServer(allowWrites: () => boolean): McpServer {
  const server = new McpServer(
    {
      name: "vscode-lsp-mcp-bridge",
      version: "0.1.4"
    },
    {
      instructions: [
        "These tools are the primary semantic-navigation interface for the active VS Code workspace.",
        "For references, definitions, implementations, callers/callees, diagnostics, hover, rename, and symbol lookup, use these tools before shell commands, rg/grep, or raw file search.",
        "If the exact symbol position is unknown, use workspace_symbols or document_symbols to locate it, then call the position-based tool.",
        "Do not use text search as a cross-check unless the user asks for text search or the language provider fails; state any fallback clearly.",
        "Tool inputs and results use one-based editor line and column values.",
        "Location-list tools include sourceLine when available; use it to summarize reference intent before falling back to raw file reads or text search.",
        "Tool results are compact for LLM use: use file, line, column, and sourceLine directly in user-facing answers and follow-up tool calls.",
        "Write-capable tools only apply edits when the VS Code setting vscodeLspMcpBridge.enableWriteTools is true and the user approves the VS Code modal confirmation."
      ].join(" ")
    }
  );

  for (const definition of toolDefinitions) {
    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema,
        annotations: {
          readOnlyHint: definition.readOnly,
          openWorldHint: false
        }
      },
      async input => {
        const result = await runLanguageTool(definition.name, input as Record<string, unknown>, {
          allowWrites: allowWrites()
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }
    );
  }

  return server;
}
