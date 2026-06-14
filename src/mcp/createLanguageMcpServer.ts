import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runLanguageTool } from "../languageTools.js";
import { toolDefinitions } from "./toolDefinitions.js";

export function createLanguageMcpServer(allowWrites: () => boolean): McpServer {
  const server = new McpServer(
    {
      name: "vscode-lsp-mcp-bridge",
      version: "0.0.1"
    },
    {
      instructions: [
        "Use these tools for semantic code navigation through the active VS Code workspace.",
        "Positions are zero-based line and character offsets.",
        "Write-capable tools only apply edits when the VS Code setting vscodeLspMcpBridge.enableWriteTools is true."
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

