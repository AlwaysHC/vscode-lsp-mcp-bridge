import * as vscode from "vscode";
import { validateLanguageToolArgs } from "./mcp/toolDefinitions.js";
import { applyCompletion, completion } from "./languageTools/completions.js";
import { diagnostics } from "./languageTools/diagnostics.js";
import {
  codeLens,
  colorPresentations,
  documentColors,
  documentLinks,
  foldingRanges,
  inlayHints,
  inlineValues,
  selectionRanges,
  semanticTokens,
  signatureHelp
} from "./languageTools/documentFeatures.js";
import {
  callHierarchy,
  callRelationshipsForSymbol,
  hierarchyForSymbol,
  typeHierarchy
} from "./languageTools/hierarchies.js";
import {
  executeAtPosition,
  executeDocument,
  languageCapabilities,
  locationsWithSourceLines,
  normalizeDocumentHighlights,
  normalizeDocumentSymbols,
  normalizeHovers,
  resultLimit,
  semanticNavigationGuide,
  workspaceSymbols
} from "./languageTools/runtime.js";
import { definitionForSymbol, referencesForSymbol } from "./languageTools/symbols.js";
import { symbolContextAtPosition, symbolContextForSymbol } from "./languageTools/symbolContext.js";
import type { ToolOptions } from "./languageTools/types.js";
import { readVirtualDocument } from "./languageTools/virtualDocuments.js";
import {
  applyCodeAction,
  codeActions,
  formatDocument,
  formatOnType,
  formatRange,
  normalizePrepareRename,
  rename,
  sourceAction
} from "./languageTools/writeTools.js";

export async function runLanguageTool(
  name: string,
  args: Record<string, unknown>,
  options: ToolOptions
): Promise<unknown> {
  args = validateLanguageToolArgs(name, args);
  switch (name) {
    case "semantic_navigation_guide":
      return semanticNavigationGuide();
    case "language_capabilities":
      return languageCapabilities(args);
    case "find_references":
      return locationsWithSourceLines(
        await executeAtPosition<vscode.Location[]>("vscode.executeReferenceProvider", args),
        resultLimit(args, 500)
      );
    case "find_references_for_symbol":
      return referencesForSymbol(args);
    case "go_to_definition":
      return locationsWithSourceLines(
        await executeAtPosition<Array<vscode.Location | vscode.LocationLink>>("vscode.executeDefinitionProvider", args),
        resultLimit(args, 100)
      );
    case "find_definition_for_symbol":
      return definitionForSymbol(args);
    case "go_to_declaration":
      return locationsWithSourceLines(
        await executeAtPosition<Array<vscode.Location | vscode.LocationLink>>("vscode.executeDeclarationProvider", args),
        resultLimit(args, 100)
      );
    case "go_to_implementation":
      return locationsWithSourceLines(
        await executeAtPosition<Array<vscode.Location | vscode.LocationLink>>("vscode.executeImplementationProvider", args),
        resultLimit(args, 250)
      );
    case "go_to_type_definition":
      return locationsWithSourceLines(
        await executeAtPosition<Array<vscode.Location | vscode.LocationLink>>("vscode.executeTypeDefinitionProvider", args),
        resultLimit(args, 100)
      );
    case "hover":
      return normalizeHovers(await executeAtPosition<vscode.Hover[]>("vscode.executeHoverProvider", args));
    case "document_symbols":
      return normalizeDocumentSymbols(
        await executeDocument<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>(
          "vscode.executeDocumentSymbolProvider",
          args
        ),
        resultLimit(args, 1_000)
      );
    case "workspace_symbols":
      return workspaceSymbols(args);
    case "document_highlights":
      return normalizeDocumentHighlights(
        await executeAtPosition<vscode.DocumentHighlight[]>("vscode.executeDocumentHighlights", args),
        resultLimit(args, 1_000)
      );
    case "diagnostics":
      return diagnostics(args);
    case "symbol_context":
      return symbolContextAtPosition(args);
    case "symbol_context_for_symbol":
      return symbolContextForSymbol(args);
    case "find_callers_for_symbol":
      return callRelationshipsForSymbol(args, "incoming");
    case "find_callees_for_symbol":
      return callRelationshipsForSymbol(args, "outgoing");
    case "call_hierarchy_for_symbol":
      return hierarchyForSymbol(args, "call");
    case "call_hierarchy":
      return callHierarchy(args);
    case "type_hierarchy_for_symbol":
      return hierarchyForSymbol(args, "type");
    case "type_hierarchy":
      return typeHierarchy(args);
    case "selection_ranges":
      return selectionRanges(args);
    case "document_links":
      return documentLinks(args);
    case "semantic_tokens":
      return semanticTokens(args, false);
    case "range_semantic_tokens":
      return semanticTokens(args, true);
    case "folding_ranges":
      return foldingRanges(args);
    case "document_colors":
      return documentColors(args);
    case "color_presentations":
      return colorPresentations(args);
    case "inline_values":
      return inlineValues(args);
    case "completion":
      return completion(args);
    case "apply_completion":
      return applyCompletion(args, options);
    case "signature_help":
      return signatureHelp(args);
    case "code_lens":
      return codeLens(args);
    case "inlay_hints":
      return inlayHints(args);
    case "code_actions":
      return codeActions(args);
    case "apply_code_action":
      return applyCodeAction(args, options);
    case "organize_imports":
      return sourceAction(args, options, vscode.CodeActionKind.SourceOrganizeImports.value, "organize_imports");
    case "fix_all":
      return sourceAction(args, options, vscode.CodeActionKind.SourceFixAll.value, "fix_all");
    case "format_document":
      return formatDocument(args, options);
    case "format_range":
      return formatRange(args, options);
    case "format_on_type":
      return formatOnType(args, options);
    case "prepare_rename":
      return normalizePrepareRename(
        await executeAtPosition<vscode.Range | { range: vscode.Range; placeholder: string }>("vscode.prepareRename", args)
      );
    case "preview_rename":
      return rename(args, { ...options, forcePreviewOnly: true });
    case "rename_symbol":
      return rename(args, options);
    case "read_virtual_document":
      return readVirtualDocument(args);
    default:
      throw new Error(`Unknown language tool: ${name}`);
  }
}
