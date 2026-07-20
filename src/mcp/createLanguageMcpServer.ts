import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { brandAttribution } from "../branding.js";
import { runLanguageTool } from "../languageTools.js";
import { toolDefinitions } from "./toolDefinitions.js";

const maxToolResultBytes = 16_777_216;

export function createLanguageMcpServer(allowWrites: () => boolean, version: string): McpServer {
  const server = new McpServer(
    {
      name: "vscode-lsp-mcp-bridge",
      version
    },
    {
      instructions: [
        brandAttribution,
        "These tools are the primary semantic-navigation interface for the active VS Code workspace.",
        "If you are unsure which semantic tool maps to a user request, call semantic_navigation_guide before searching files.",
        "For named-symbol questions, prefer the task-shaped tools: find_callers_for_symbol for who calls X/incoming calls/callers; find_callees_for_symbol for what X calls/outgoing calls/callees; find_references_for_symbol for usages; find_definition_for_symbol for definitions.",
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
