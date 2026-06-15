import * as z from "zod/v4";

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  readOnly: boolean;
}

const positionSchema = {
  file: z.string().describe("Absolute or workspace-relative file path."),
  line: z.number().int().positive().describe("One-based editor line number."),
  column: z.number().int().positive().describe("One-based editor column number.")
};

const documentSchema = {
  file: z.string().describe("Absolute or workspace-relative file path.")
};

const symbolQuerySchema = {
  query: z.string().describe("Symbol name or qualified name, for example AgendasController.GetBySalonInternal."),
  containerName: z.string().optional().describe("Optional containing type or namespace used to disambiguate matches."),
  file: z.string().optional().describe("Optional absolute or workspace-relative file path used to disambiguate matches."),
  kind: z.string().optional().describe("Optional VS Code symbol kind, for example Method, Function, Class, or Property."),
  maxCandidates: z.number().int().positive().optional().describe("Maximum number of ranked symbol candidates to inspect.")
};

export const toolDefinitions: ToolDefinition[] = [
  {
    name: "find_references",
    title: "Find References",
    description: "Find semantic references for the symbol at a file position. Use this instead of rg/grep/text search for symbol references.",
    inputSchema: positionSchema,
    readOnly: true
  },
  {
    name: "go_to_definition",
    title: "Go To Definition",
    description: "Find semantic definitions for the symbol at a file position using VS Code language providers.",
    inputSchema: positionSchema,
    readOnly: true
  },
  {
    name: "go_to_declaration",
    title: "Go To Declaration",
    description: "Find semantic declarations for the symbol at a file position using VS Code language providers.",
    inputSchema: positionSchema,
    readOnly: true
  },
  {
    name: "go_to_implementation",
    title: "Go To Implementation",
    description: "Find semantic implementations for the symbol at a file position using VS Code language providers.",
    inputSchema: positionSchema,
    readOnly: true
  },
  {
    name: "go_to_type_definition",
    title: "Go To Type Definition",
    description: "Find semantic type definitions for the symbol at a file position using VS Code language providers.",
    inputSchema: positionSchema,
    readOnly: true
  },
  {
    name: "hover",
    title: "Hover",
    description: "Return semantic hover information for the symbol or token at a file position.",
    inputSchema: positionSchema,
    readOnly: true
  },
  {
    name: "document_symbols",
    title: "Document Symbols",
    description: "Return semantic symbols for a file. Use this to find the exact line and column before calling position-based tools.",
    inputSchema: documentSchema,
    readOnly: true
  },
  {
    name: "workspace_symbols",
    title: "Workspace Symbols",
    description: "Search workspace symbols using installed VS Code language providers. Use this before text search when only a symbol name is known. For call hierarchy by name, prefer call_hierarchy_for_symbol.",
    inputSchema: {
      query: z.string().describe("Symbol search query.")
    },
    readOnly: true
  },
  {
    name: "document_highlights",
    title: "Document Highlights",
    description: "Return semantic document highlights for the symbol at a file position.",
    inputSchema: positionSchema,
    readOnly: true
  },
  {
    name: "diagnostics",
    title: "Diagnostics",
    description: "Return VS Code language diagnostics for one file, or all diagnostics if file is omitted.",
    inputSchema: {
      file: z.string().optional().describe("Optional absolute or workspace-relative file path.")
    },
    readOnly: true
  },
  {
    name: "call_hierarchy_for_symbol",
    title: "Call Hierarchy For Symbol",
    description: "Resolve a symbol by name with VS Code workspace symbols, then return semantic incoming and outgoing calls. Use this instead of rg/grep/text search when only a method or symbol name is known.",
    inputSchema: symbolQuerySchema,
    readOnly: true
  },
  {
    name: "call_hierarchy",
    title: "Call Hierarchy",
    description: "Return semantic incoming and outgoing calls for a symbol position. Use this instead of text search for callers and callees.",
    inputSchema: positionSchema,
    readOnly: true
  },
  {
    name: "completion",
    title: "Completion",
    description: "Return language-provider completion items at a file position.",
    inputSchema: {
      ...positionSchema,
      triggerCharacter: z.string().optional().describe("Optional completion trigger character."),
      itemResolveCount: z.number().int().positive().optional().describe("Maximum number of items to resolve.")
    },
    readOnly: true
  },
  {
    name: "signature_help",
    title: "Signature Help",
    description: "Return language-provider signature help at a file position.",
    inputSchema: positionSchema,
    readOnly: true
  },
  {
    name: "code_lens",
    title: "Code Lens",
    description: "Return language-provider code lenses for a file.",
    inputSchema: documentSchema,
    readOnly: true
  },
  {
    name: "inlay_hints",
    title: "Inlay Hints",
    description: "Return language-provider inlay hints for a file.",
    inputSchema: documentSchema,
    readOnly: true
  },
  {
    name: "code_actions",
    title: "Code Actions",
    description: "Return available language-provider code action titles for a file without applying them.",
    inputSchema: documentSchema,
    readOnly: true
  },
  {
    name: "format_document",
    title: "Format Document",
    description: "Preview document formatting edits. Can apply edits only when explicitly enabled.",
    inputSchema: {
      ...documentSchema,
      apply: z.boolean().optional().describe("Apply the formatting edits. Requires write tools to be enabled.")
    },
    readOnly: false
  },
  {
    name: "prepare_rename",
    title: "Prepare Rename",
    description: "Check semantically whether the symbol at a file position can be renamed.",
    inputSchema: positionSchema,
    readOnly: true
  },
  {
    name: "preview_rename",
    title: "Preview Rename",
    description: "Preview a semantic rename workspace edit without applying it.",
    inputSchema: {
      ...positionSchema,
      newName: z.string().describe("New symbol name.")
    },
    readOnly: true
  },
  {
    name: "rename_symbol",
    title: "Rename Symbol",
    description: "Preview or apply a semantic symbol rename. Applying requires write tools to be enabled.",
    inputSchema: {
      ...positionSchema,
      newName: z.string().describe("New symbol name."),
      apply: z.boolean().optional().describe("Apply the rename. Requires write tools to be enabled.")
    },
    readOnly: false
  }
];
