import * as z from "zod/v4";
import { brand } from "../branding.js";

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  readOnly: boolean;
}

const documentSchema = {
  file: z.string().min(1).max(32_768).describe("Workspace-relative path, or an absolute path within the open workspace.")
};

const positionSchema = {
  ...documentSchema,
  line: z.number().int().positive().describe("One-based editor line number."),
  column: z.number().int().positive().describe("One-based editor column number.")
};

const rangeSchema = {
  ...documentSchema,
  startLine: z.number().int().positive().describe("One-based range start line."),
  startColumn: z.number().int().positive().describe("One-based range start column."),
  endLine: z.number().int().positive().describe("One-based range end line."),
  endColumn: z.number().int().positive().describe("One-based range end column.")
};

const optionalRangeSchema = {
  ...documentSchema,
  startLine: z.number().int().positive().optional().describe("Optional one-based range start line. Omit all range fields for the whole document."),
  startColumn: z.number().int().positive().optional().describe("Optional one-based range start column."),
  endLine: z.number().int().positive().optional().describe("Optional one-based range end line."),
  endColumn: z.number().int().positive().optional().describe("Optional one-based range end column.")
};

const formattingSchema = {
  tabSize: z.number().int().positive().optional().describe("Formatting tab size. Defaults to 4."),
  insertSpaces: z.boolean().optional().describe("Use spaces instead of tabs. Defaults to true."),
  apply: z.boolean().optional().describe("Apply the edits. Requires write tools to be enabled and a VS Code user approval.")
};

const codeActionSchema = {
  ...optionalRangeSchema,
  kind: z.string().optional().describe("Optional code action kind, for example quickfix, refactor, source.organizeImports, or source.fixAll."),
  itemResolveCount: z.number().int().positive().max(10_000).optional().describe("Maximum number of actions to resolve.")
};

const applyCodeActionSchema = {
  ...codeActionSchema,
  actionIndex: z.number().int().positive().optional().describe("One-based index from the code_actions result. Defaults to 1."),
  title: z.string().optional().describe("Optional action title filter."),
  exactTitle: z.boolean().optional().describe("Require exact title match instead of substring match."),
  executeCommand: z.boolean().optional().describe("Execute the selected action command after applying its edit. Defaults to true.")
};

const sourceActionSchema = {
  ...documentSchema,
  apply: z.boolean().optional().describe("Apply the selected source action. Requires write tools to be enabled and a VS Code user approval."),
  actionIndex: z.number().int().positive().optional().describe("One-based source action index. Defaults to 1."),
  title: z.string().optional().describe("Optional source action title filter."),
  exactTitle: z.boolean().optional().describe("Require exact title match instead of substring match."),
  executeCommand: z.boolean().optional().describe("Execute the selected action command after applying its edit. Defaults to true."),
  itemResolveCount: z.number().int().positive().max(10_000).optional().describe("Maximum number of source actions to resolve.")
};

const symbolQuerySchema = {
  query: z.string().min(1).max(1_000).describe("Symbol name or qualified name, for example AgendasController.GetBySalonInternal."),
  containerName: z.string().optional().describe("Optional containing type or namespace used to disambiguate matches."),
  file: z.string().optional().describe("Optional absolute or workspace-relative file path used to disambiguate matches."),
  kind: z.string().optional().describe("Optional VS Code symbol kind, for example Method, Function, Class, or Property."),
  maxCandidates: z.number().int().positive().max(10_000).optional().describe("Maximum number of ranked symbol candidates to inspect.")
};

const colorSchema = {
  ...rangeSchema,
  red: z.number().min(0).max(1).describe("Red channel from 0 to 1."),
  green: z.number().min(0).max(1).describe("Green channel from 0 to 1."),
  blue: z.number().min(0).max(1).describe("Blue channel from 0 to 1."),
  alpha: z.number().min(0).max(1).optional().describe("Alpha channel from 0 to 1. Defaults to 1.")
};

const baseToolDefinitions: ToolDefinition[] = [
  {
    name: "semantic_navigation_guide",
    title: "Semantic Navigation Guide",
    description: "Read this when deciding whether to use vscode_lsp tools. It maps user phrases like incoming calls, callers, references, definitions, implementations, and type hierarchy to the right semantic tool, and explains when rg/grep is only a fallback.",
    inputSchema: {},
    readOnly: true
  },
  {
    name: "find_callers_for_symbol",
    title: "Find Callers For Symbol",
    description: "Use this first when the user asks who calls a named symbol, incoming calls, callers, call sites, or file/line for each caller. Resolves the symbol by name and returns semantic callers only, with caller file/line and call-site file/line. Prefer this over rg/grep/text search.",
    inputSchema: symbolQuerySchema,
    readOnly: true
  },
  {
    name: "find_callees_for_symbol",
    title: "Find Callees For Symbol",
    description: "Use this first when the user asks what a named symbol calls, outgoing calls, callees, or call sites. Resolves the symbol by name and returns semantic callees only, with callee file/line and call-site file/line. Prefer this over rg/grep/text search.",
    inputSchema: symbolQuerySchema,
    readOnly: true
  },
  {
    name: "find_references_for_symbol",
    title: "Find References For Symbol",
    description: "Use this first when the user asks for references, usages, or where a named symbol is used and only gives a symbol name. Resolves the symbol by name, then returns semantic references with sourceLine. Prefer this over rg/grep/text search for code references.",
    inputSchema: symbolQuerySchema,
    readOnly: true
  },
  {
    name: "find_definition_for_symbol",
    title: "Find Definition For Symbol",
    description: "Use this first when the user asks for the definition, declaration target, or where a named symbol is defined and only gives a symbol name. Resolves the symbol by name, then asks VS Code for semantic definitions.",
    inputSchema: symbolQuerySchema,
    readOnly: true
  },
  {
    name: "find_references",
    title: "Find References",
    description: "Find semantic references for the symbol at a known file position. Results include sourceLine when available; use this instead of rg/grep/text search for symbol references. If only a symbol name is known, use find_references_for_symbol first.",
    inputSchema: positionSchema,
    readOnly: true
  },
  {
    name: "go_to_definition",
    title: "Go To Definition",
    description: "Find semantic definitions for the symbol at a known file position using VS Code language providers. Results include sourceLine when available. If only a symbol name is known, use find_definition_for_symbol first.",
    inputSchema: positionSchema,
    readOnly: true
  },
  {
    name: "go_to_declaration",
    title: "Go To Declaration",
    description: "Find semantic declarations for the symbol at a file position using VS Code language providers. Results include sourceLine when available.",
    inputSchema: positionSchema,
    readOnly: true
  },
  {
    name: "go_to_implementation",
    title: "Go To Implementation",
    description: "Find semantic implementations for the symbol at a file position using VS Code language providers. Results include sourceLine when available.",
    inputSchema: positionSchema,
    readOnly: true
  },
  {
    name: "go_to_type_definition",
    title: "Go To Type Definition",
    description: "Find semantic type definitions for the symbol at a file position using VS Code language providers. Results include sourceLine when available.",
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
    description: "Search workspace symbols using installed VS Code language providers. Use this before text search when only a symbol name is known, or to disambiguate before semantic references, definitions, callers, callees, and hierarchy tools.",
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
    description: "Resolve a symbol by name with VS Code workspace symbols, then return the full semantic call hierarchy with incoming and outgoing calls. For user questions about only callers/incoming calls, use find_callers_for_symbol first. For only callees/outgoing calls, use find_callees_for_symbol first.",
    inputSchema: symbolQuerySchema,
    readOnly: true
  },
  {
    name: "call_hierarchy",
    title: "Call Hierarchy",
    description: "Return semantic incoming and outgoing calls for a known symbol position. Use this instead of text search for callers and callees. If only a symbol name is known, use find_callers_for_symbol, find_callees_for_symbol, or call_hierarchy_for_symbol first.",
    inputSchema: positionSchema,
    readOnly: true
  },
  {
    name: "type_hierarchy_for_symbol",
    title: "Type Hierarchy For Symbol",
    description: "Resolve a symbol by name with VS Code workspace symbols, then return semantic supertypes and subtypes.",
    inputSchema: symbolQuerySchema,
    readOnly: true
  },
  {
    name: "type_hierarchy",
    title: "Type Hierarchy",
    description: "Return semantic supertypes and subtypes for a type symbol position.",
    inputSchema: positionSchema,
    readOnly: true
  },
  {
    name: "selection_ranges",
    title: "Selection Ranges",
    description: "Return semantic expanding selection ranges for a file position.",
    inputSchema: positionSchema,
    readOnly: true
  },
  {
    name: "document_links",
    title: "Document Links",
    description: "Return language-provider document links for a file.",
    inputSchema: {
      ...documentSchema,
      linkResolveCount: z.number().int().positive().max(10_000).optional().describe("Maximum number of unresolved links to resolve.")
    },
    readOnly: true
  },
  {
    name: "semantic_tokens",
    title: "Semantic Tokens",
    description: "Return decoded document semantic tokens with token type and modifiers when the language provider supports them.",
    inputSchema: documentSchema,
    readOnly: true
  },
  {
    name: "range_semantic_tokens",
    title: "Range Semantic Tokens",
    description: "Return decoded semantic tokens for a document range.",
    inputSchema: rangeSchema,
    readOnly: true
  },
  {
    name: "folding_ranges",
    title: "Folding Ranges",
    description: "Return language-provider folding ranges for a file.",
    inputSchema: documentSchema,
    readOnly: true
  },
  {
    name: "document_colors",
    title: "Document Colors",
    description: "Return language-provider color ranges for a file.",
    inputSchema: documentSchema,
    readOnly: true
  },
  {
    name: "color_presentations",
    title: "Color Presentations",
    description: "Return language-provider textual presentations for a color at a range.",
    inputSchema: colorSchema,
    readOnly: true
  },
  {
    name: "inline_values",
    title: "Inline Values",
    description: "Return debugger inline values for a range when an inline-values provider supports the file.",
    inputSchema: {
      ...optionalRangeSchema,
      frameId: z.number().int().nonnegative().optional().describe("Debug adapter frame id. Defaults to 0."),
      stoppedLine: z.number().int().positive().optional().describe("Optional one-based stopped-location line."),
      stoppedColumn: z.number().int().positive().optional().describe("Optional one-based stopped-location column.")
    },
    readOnly: true
  },
  {
    name: "completion",
    title: "Completion",
    description: "Return language-provider completion items at a file position.",
    inputSchema: {
      ...positionSchema,
      triggerCharacter: z.string().optional().describe("Optional completion trigger character."),
      itemResolveCount: z.number().int().positive().max(10_000).optional().describe("Maximum number of items to resolve.")
    },
    readOnly: true
  },
  {
    name: "signature_help",
    title: "Signature Help",
    description: "Return language-provider signature help at a file position.",
    inputSchema: {
      ...positionSchema,
      triggerCharacter: z.string().optional().describe("Optional signature-help trigger character.")
    },
    readOnly: true
  },
  {
    name: "code_lens",
    title: "Code Lens",
    description: "Return language-provider code lenses for a file.",
    inputSchema: {
      ...documentSchema,
      itemResolveCount: z.number().int().positive().max(10_000).optional().describe("Maximum number of code lenses to resolve.")
    },
    readOnly: true
  },
  {
    name: "inlay_hints",
    title: "Inlay Hints",
    description: "Return language-provider inlay hints for a file or range.",
    inputSchema: optionalRangeSchema,
    readOnly: true
  },
  {
    name: "code_actions",
    title: "Code Actions",
    description: "Return available language-provider code actions, including previewable edits when resolved.",
    inputSchema: codeActionSchema,
    readOnly: true
  },
  {
    name: "apply_code_action",
    title: "Apply Code Action",
    description: "Apply a selected language-provider code action by index or title. Requires write tools to be enabled and a VS Code user approval.",
    inputSchema: applyCodeActionSchema,
    readOnly: false
  },
  {
    name: "organize_imports",
    title: "Organize Imports",
    description: "Preview or apply the source.organizeImports code action. Applying requires write tools to be enabled and a VS Code user approval. In C# this maps to organize usings when provided by Roslyn.",
    inputSchema: sourceActionSchema,
    readOnly: false
  },
  {
    name: "fix_all",
    title: "Fix All",
    description: "Preview or apply the source.fixAll code action when provided by the language provider. Applying requires write tools to be enabled and a VS Code user approval.",
    inputSchema: sourceActionSchema,
    readOnly: false
  },
  {
    name: "format_document",
    title: "Format Document",
    description: "Preview or apply document formatting edits. Applying requires write tools to be enabled and a VS Code user approval.",
    inputSchema: {
      ...documentSchema,
      ...formattingSchema
    },
    readOnly: false
  },
  {
    name: "format_range",
    title: "Format Range",
    description: "Preview or apply range formatting edits. Applying requires write tools to be enabled and a VS Code user approval.",
    inputSchema: {
      ...rangeSchema,
      ...formattingSchema
    },
    readOnly: false
  },
  {
    name: "format_on_type",
    title: "Format On Type",
    description: "Preview or apply on-type formatting edits for a trigger character at a file position. Applying requires write tools to be enabled and a VS Code user approval.",
    inputSchema: {
      ...positionSchema,
      triggerCharacter: z.string().describe("Formatting trigger character."),
      ...formattingSchema
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
    description: "Preview or apply a semantic symbol rename. Applying requires write tools to be enabled and a VS Code user approval.",
    inputSchema: {
      ...positionSchema,
      newName: z.string().describe("New symbol name."),
      apply: z.boolean().optional().describe("Apply the rename. Requires write tools to be enabled and a VS Code user approval.")
    },
    readOnly: false
  }
];

export const toolDefinitions: ToolDefinition[] = baseToolDefinitions.map(definition => ({
  ...definition,
  title: brand(definition.title),
  description: brand(definition.description)
}));
