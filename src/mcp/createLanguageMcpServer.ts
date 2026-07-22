import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runLanguageTool } from "../languageTools.js";
import { languageMcpServerInstructions } from "./serverInstructions.js";
import { toolDefinitions } from "./toolDefinitions.js";

const maxToolResultBytes = 16_777_216;

export function createLanguageMcpServer(allowWrites: () => boolean, version: string): McpServer {
  const server = new McpServer(
    {
      name: "vscode-lsp-mcp-bridge",
      version
    },
    {
      instructions: languageMcpServerInstructions
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
          openWorldHint: definition.openWorld ?? false,
          destructiveHint: !definition.readOnly,
          idempotentHint: definition.readOnly
        }
      },
      async input => {
        const result = await runLanguageTool(definition.name, input as Record<string, unknown>, {
          allowWrites: allowWrites()
        });
        const text = JSON.stringify(result ?? null, null, 2);
        if (Buffer.byteLength(text) > maxToolResultBytes) {
          throw new Error("Language tool result exceeded the bridge output limit.");
        }

        return {
          content: [
            {
              type: "text",
              text
            }
          ]
        };
      }
    );
  }

  return server;
}
