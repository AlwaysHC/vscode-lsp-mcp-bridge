import * as vscode from "vscode";
import { brand } from "./branding.js";
import { getNotificationDurationMs } from "./configuration.js";

export function showStatusNotification(message: string): vscode.Disposable {
  return vscode.window.setStatusBarMessage(brand(message), getNotificationDurationMs());
}
