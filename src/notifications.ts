import * as vscode from "vscode";
import { getNotificationDurationMs } from "./configuration.js";

export function showStatusNotification(message: string): vscode.Disposable {
  return vscode.window.setStatusBarMessage(message, getNotificationDurationMs());
}
