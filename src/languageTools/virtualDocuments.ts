import * as vscode from "vscode";
import { boundedInteger } from "../languageToolCore.js";
import { brand, brandAttribution } from "../branding.js";
import {
  deleteVirtualDocumentGrant,
  formatUriForApproval,
  getVirtualDocumentGrant,
  isBlockedVirtualDocumentScheme,
  isUriInWorkspace,
  openDocumentUri,
  refreshVirtualDocumentGrant,
  stringArg,
  withTimeout
} from "./runtime.js";

const virtualDocumentMaxCharacters = 262_144;

export async function readVirtualDocument(args: Record<string, unknown>): Promise<object> {
  const anchorUri = await openDocumentUri(stringArg(args, "file"));
  const reference = stringArg(args, "virtualDocumentRef");
  const grant = getVirtualDocumentGrant(reference);
  if (!grant) {
    throw new Error("The virtual-document reference is invalid or expired. Request the provider result again.");
  }
  if (isBlockedVirtualDocumentScheme(grant.uri.scheme) || isUriInWorkspace(grant.uri)) {
    deleteVirtualDocumentGrant(reference);
    throw new Error("The virtual-document reference is not eligible for provider-backed reading.");
  }
  if (!grant.approved) {
    const choice = await vscode.window.showWarningMessage(
      brand("Allow MCP to open a provider-backed virtual document?"),
      {
        modal: true,
        detail: [
          brandAttribution,
          brand(`Source workspace file: ${formatUriForApproval(anchorUri)}`),
          brand(`Virtual document scheme: ${grant.uri.scheme}`),
          brand("Opening it can activate the owning extension or access an external service. The URI remains hidden and returned text is size-limited.")
        ].join("\n\n")
      },
      brand("Open Read-Only Document")
    );
    if (choice !== brand("Open Read-Only Document")) {
      return { approved: false, opened: false };
    }
    grant.approved = true;
  }

  let document: vscode.TextDocument;
  try {
    document = await withTimeout(
      vscode.workspace.openTextDocument(grant.uri),
      10_000,
      "The virtual-document provider did not respond within 10 seconds."
    );
  } catch {
    deleteVirtualDocumentGrant(reference);
    throw new Error("The provider-backed virtual document could not be opened.");
  }
  const startLine = boundedInteger(args.startLine, "startLine", {
    defaultValue: 1,
    maximum: Math.max(1, document.lineCount)
  });
  const maxLines = boundedInteger(args.maxLines, "maxLines", { defaultValue: 200, maximum: 1_000 });
  const maxCharacters = boundedInteger(args.maxCharacters, "maxCharacters", {
    defaultValue: virtualDocumentMaxCharacters,
    maximum: virtualDocumentMaxCharacters
  });
  const startIndex = startLine - 1;
  const endIndexExclusive = Math.min(document.lineCount, startIndex + maxLines);
  const endPosition = endIndexExclusive >= document.lineCount
    ? document.lineAt(Math.max(0, document.lineCount - 1)).range.end
    : new vscode.Position(endIndexExclusive, 0);
  const fullText = document.getText(new vscode.Range(new vscode.Position(startIndex, 0), endPosition));
  const text = fullText.slice(0, maxCharacters);
  refreshVirtualDocumentGrant(grant);
  return {
    approved: true,
    opened: true,
    virtualDocumentRef: reference,
    uriScheme: grant.uri.scheme,
    languageId: document.languageId,
    startLine,
    endLine: Math.min(document.lineCount, startLine + maxLines - 1),
    totalLines: document.lineCount,
    text,
    truncated: endIndexExclusive < document.lineCount || text.length < fullText.length
  };
}
