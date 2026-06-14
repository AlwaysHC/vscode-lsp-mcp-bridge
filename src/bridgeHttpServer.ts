import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import * as vscode from "vscode";
import { runLanguageTool } from "./languageTools.js";
import { createLanguageMcpServer } from "./mcp/createLanguageMcpServer.js";
import { defaultConnectionFilePath } from "./shared/paths.js";
import {
  BRIDGE_VERSION,
  BridgeConnectionInfo,
  BridgeToolRequest,
  BridgeToolResponse,
  DEFAULT_HOST,
  DEFAULT_PORT
} from "./shared/protocol.js";

export class BridgeHttpServer {
  private server: http.Server | undefined;
  private connectionInfo: BridgeConnectionInfo | undefined;
  private connectionFile: string | undefined;
  private mcpSessions = new Map<
    string,
    {
      transport: StreamableHTTPServerTransport;
      server: McpServer;
    }
  >();

  constructor(private readonly context: vscode.ExtensionContext) {}

  get isRunning(): boolean {
    return this.server !== undefined && this.connectionInfo !== undefined;
  }

  get status(): string {
    if (!this.connectionInfo || !this.connectionFile) {
      return "VS Code LSP MCP Bridge is stopped.";
    }

    return [
      "VS Code LSP MCP Bridge is running.",
      `MCP endpoint: http://${this.connectionInfo.host}:${this.connectionInfo.port}/mcp`,
      `Debug endpoint: http://${this.connectionInfo.host}:${this.connectionInfo.port}/tool`,
      `Connection file: ${this.connectionFile}`,
      `Workspace folders: ${this.connectionInfo.workspaceFolders.length}`
    ].join("\n");
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    if (!vscode.workspace.isTrusted) {
      throw new Error("The bridge refuses to start in an untrusted workspace.");
    }

    const config = vscode.workspace.getConfiguration("vscodeLspMcpBridge");
    const host = config.get<string>("host", DEFAULT_HOST);
    const port = config.get<number>("port", DEFAULT_PORT);
    const configuredConnectionFile = config.get<string>("connectionFile", "").trim();
    const token = await this.getOrCreateToken();

    this.connectionFile = configuredConnectionFile || defaultConnectionFilePath();
    this.connectionInfo = {
      version: BRIDGE_VERSION,
      host,
      port,
      token,
      workspaceFolders: vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [],
      createdAt: new Date().toISOString()
    };

    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(port, host, () => {
        this.server?.off("error", reject);
        resolve();
      });
    });

    await this.writeConnectionFile();
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.connectionInfo = undefined;

    await this.closeMcpSessions();

    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }
  }

  getCodexConfigSnippet(): string {
    const host = this.connectionInfo?.host ?? DEFAULT_HOST;
    const port = this.connectionInfo?.port ?? DEFAULT_PORT;
    const token = this.connectionInfo?.token ?? "<start-the-bridge-first>";

    return [
      "[mcp_servers.vscode_lsp]",
      `url = "http://${host}:${port}/mcp"`,
      `http_headers = { Authorization = "Bearer ${token}" }`
    ].join("\n");
  }

  private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    try {
      if (request.method === "GET" && request.url === "/health") {
        this.writeJson(response, 200, {
          ok: true,
          running: this.isRunning,
          version: BRIDGE_VERSION,
          mcp: "/mcp"
        });
        return;
      }

      const requestPath = request.url?.split("?", 1)[0];

      if (requestPath === "/mcp") {
        if (!this.isAuthorized(request)) {
          this.writeMcpError(response, 401, -32001, "Unauthorized");
          return;
        }

        await this.handleMcpRequest(request, response);
        return;
      }

      if (request.method !== "POST" || requestPath !== "/tool") {
        this.writeJson(response, 404, { ok: false, error: "Not found" });
        return;
      }

      if (!this.isAuthorized(request)) {
        this.writeJson(response, 401, { ok: false, error: "Unauthorized" });
        return;
      }

      const body = await this.readJson<BridgeToolRequest>(request);
      const allowWrites = vscode.workspace
        .getConfiguration("vscodeLspMcpBridge")
        .get<boolean>("enableWriteTools", false);

      const result = await runLanguageTool(body.name, body.args ?? {}, { allowWrites });
      this.writeJson(response, 200, { ok: true, result } satisfies BridgeToolResponse);
    } catch (error) {
      this.writeJson(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      } satisfies BridgeToolResponse);
    }
  }

  private async handleMcpRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const method = request.method?.toUpperCase();
    const sessionId = this.getHeader(request, "mcp-session-id");

    if (method === "POST") {
      const body = await this.readJson<unknown>(request);

      if (sessionId) {
        const session = this.mcpSessions.get(sessionId);
        if (!session) {
          this.writeMcpError(response, 404, -32000, "Unknown MCP session.");
          return;
        }

        await session.transport.handleRequest(request, response, body);
        return;
      }

      if (!isInitializeRequest(body)) {
        this.writeMcpError(response, 400, -32000, "Missing MCP session. Send initialize first.");
        return;
      }

      let initializedSessionId: string | undefined;
      const mcpServer = createLanguageMcpServer(() => this.allowWrites);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: newSessionId => {
          initializedSessionId = newSessionId;
          this.mcpSessions.set(newSessionId, { transport, server: mcpServer });
        }
      });

      transport.onclose = () => {
        const closedSessionId = transport.sessionId ?? initializedSessionId;
        if (closedSessionId) {
          this.mcpSessions.delete(closedSessionId);
        }
      };

      await mcpServer.connect(transport);
      await transport.handleRequest(request, response, body);
      return;
    }

    if (method === "GET" || method === "DELETE") {
      if (!sessionId) {
        this.writeMcpError(response, 400, -32000, "Missing MCP session ID.");
        return;
      }

      const session = this.mcpSessions.get(sessionId);
      if (!session) {
        this.writeMcpError(response, 404, -32000, "Unknown MCP session.");
        return;
      }

      await session.transport.handleRequest(request, response);
      return;
    }

    this.writeMcpError(response, 405, -32000, "Method not allowed.");
  }

  private isAuthorized(request: http.IncomingMessage): boolean {
    const expected = this.connectionInfo?.token;
    const actual = request.headers.authorization;
    return Boolean(expected && actual === `Bearer ${expected}`);
  }

  private getHeader(request: http.IncomingMessage, name: string): string | undefined {
    const value = request.headers[name.toLowerCase()];
    if (Array.isArray(value)) {
      return value[0];
    }

    return value;
  }

  private async readJson<T>(request: http.IncomingMessage): Promise<T> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  }

  private writeJson(response: http.ServerResponse, statusCode: number, value: unknown): void {
    response.statusCode = statusCode;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify(value, null, 2));
  }

  private writeMcpError(
    response: http.ServerResponse,
    statusCode: number,
    code: number,
    message: string
  ): void {
    this.writeJson(response, statusCode, {
      jsonrpc: "2.0",
      error: {
        code,
        message
      },
      id: null
    });
  }

  private async writeConnectionFile(): Promise<void> {
    if (!this.connectionFile || !this.connectionInfo) {
      return;
    }

    await fs.mkdir(path.dirname(this.connectionFile), { recursive: true });
    await fs.writeFile(this.connectionFile, JSON.stringify(this.connectionInfo, null, 2), "utf8");
  }

  private async getOrCreateToken(): Promise<string> {
    const secretKey = "bridgeToken";
    const existing = await this.context.secrets.get(secretKey);
    if (existing) {
      return existing;
    }

    const token = crypto.randomBytes(32).toString("hex");
    await this.context.secrets.store(secretKey, token);
    return token;
  }

  private get allowWrites(): boolean {
    return vscode.workspace
      .getConfiguration("vscodeLspMcpBridge")
      .get<boolean>("enableWriteTools", false);
  }

  private async closeMcpSessions(): Promise<void> {
    const sessions = [...this.mcpSessions.values()];
    this.mcpSessions.clear();

    await Promise.allSettled(
      sessions.map(async session => {
        await session.server.close();
      })
    );
  }
}
