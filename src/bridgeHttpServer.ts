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

type BridgeServerRole = "gateway" | "worker";

interface WorkspaceRegistration {
  id: string;
  name: string;
  host: string;
  port: number;
  token: string;
  workspaceFolders: string[];
  startedAt: string;
  activate?: boolean;
}

interface RegisteredWorkspace extends WorkspaceRegistration {
  isLocal: boolean;
  lastSeenAt: string;
}

interface GatewayEndpoint {
  host: string;
  port: number;
  token: string;
}

const registrationRefreshMs = 30_000;
const registrationStaleMs = 90_000;

export class BridgeHttpServer {
  private server: http.Server | undefined;
  private connectionInfo: BridgeConnectionInfo | undefined;
  private connectionFile: string | undefined;
  private role: BridgeServerRole | undefined;
  private workspaceId: string | undefined;
  private actualPort: number | undefined;
  private gatewayEndpoint: GatewayEndpoint | undefined;
  private activeWorkspaceId: string | undefined;
  private registrationTimer: ReturnType<typeof setInterval> | undefined;
  private isPromoting = false;
  private registeredWorkspaces = new Map<string, RegisteredWorkspace>();
  private mcpSessionRoutes = new Map<string, string>();
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
    const version = this.extensionVersion();
    if (!this.connectionInfo || !this.connectionFile) {
      return ["VS Code LSP MCP Bridge is stopped.", `Version: ${version}`].join("\n");
    }

    const lines = [
      `VS Code LSP MCP Bridge is running as ${this.role ?? "server"}.`,
      `Version: ${version}`,
      `MCP endpoint: http://${this.connectionInfo.host}:${this.connectionInfo.port}/mcp`,
      `Connection file: ${this.connectionFile}`,
      `Workspace folders: ${this.connectionInfo.workspaceFolders.length}`
    ];

    if (this.role === "worker" && this.actualPort !== undefined) {
      lines.push(`Private worker endpoint: http://${this.connectionInfo.host}:${this.actualPort}/mcp`);
    }

    if (this.role === "gateway") {
      this.expireStaleWorkspaces();
      const activeWorkspace = this.activeWorkspaceId
        ? this.registeredWorkspaces.get(this.activeWorkspaceId)
        : undefined;
      lines.push(`Active workspace: ${activeWorkspace?.name ?? "none"}`);
      lines.push(`Registered workspaces: ${this.registeredWorkspaces.size}`);
    }

    return lines.join("\n");
  }

  private extensionVersion(): string {
    const version = this.context.extension.packageJSON.version;
    return typeof version === "string" && version.trim() ? version : "unknown";
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
    const requestedPort = config.get<number>("port", DEFAULT_PORT);
    const configuredConnectionFile = config.get<string>("connectionFile", "").trim();
    const token = await this.getOrCreateToken();

    this.connectionFile = configuredConnectionFile || defaultConnectionFilePath();
    this.workspaceId = this.createWorkspaceId();
    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    try {
      await this.listen(requestedPort, host);
      const port = this.listeningPort();
      this.role = "gateway";
      this.actualPort = port;
      this.connectionInfo = {
        version: BRIDGE_VERSION,
        host,
        port,
        token,
        workspaceFolders: vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [],
        createdAt: new Date().toISOString()
      };

      this.registerLocalWorkspace(host, port, token);
      await this.writeConnectionFile();
    } catch (error) {
      if (requestedPort === 0 || !this.isAddressInUseError(error)) {
        await this.resetAfterFailedStart();
        throw error;
      }

      await this.startWorkerBehindGateway(host, requestedPort);
    }
  }

  async stop(): Promise<void> {
    this.stopRegistrationHeartbeat();

    if (this.role === "worker") {
      await this.unregisterFromGateway().catch(() => undefined);
    }

    const server = this.server;
    this.server = undefined;
    this.connectionInfo = undefined;
    this.connectionFile = undefined;
    this.role = undefined;
    this.workspaceId = undefined;
    this.actualPort = undefined;
    this.gatewayEndpoint = undefined;
    this.activeWorkspaceId = undefined;
    this.registeredWorkspaces.clear();
    this.mcpSessionRoutes.clear();

    await this.closeMcpSessions();

    if (server) {
      await this.closeHttpServer(server);
    }
  }

  getClientConfigSnippet(clientId: string): string {
    switch (clientId) {
      case "codex":
        return this.getCodexConfigSnippet();
      case "vscode-copilot":
        return this.getVsCodeCopilotConfigSnippet();
      case "claude-code":
        return this.getClaudeCodeConfigSnippet();
      case "generic":
        return this.getGenericHttpMcpConfigSnippet();
      default:
        throw new Error(`Unknown MCP client config: ${clientId}`);
    }
  }

  private getCodexConfigSnippet(): string {
    const { host, port, token } = this.currentConnectionValues();

    return [
      "[mcp_servers.vscode_lsp]",
      `url = "http://${host}:${port}/mcp"`,
      `http_headers = { Authorization = "Bearer ${token}" }`
    ].join("\n");
  }

  private getVsCodeCopilotConfigSnippet(): string {
    const { host, port, token } = this.currentConnectionValues();

    return JSON.stringify(
      {
        servers: {
          vscode_lsp: {
            type: "http",
            url: `http://${host}:${port}/mcp`,
            requestInit: {
              headers: {
                Authorization: `Bearer ${token}`
              }
            }
          }
        }
      },
      null,
      2
    );
  }

  private getClaudeCodeConfigSnippet(): string {
    const { host, port, token } = this.currentConnectionValues();

    return `claude mcp add --transport http vscode_lsp http://${host}:${port}/mcp --header "Authorization: Bearer ${token}"`;
  }

  private getGenericHttpMcpConfigSnippet(): string {
    const { host, port, token } = this.currentConnectionValues();

    return JSON.stringify(
      {
        mcpServers: {
          vscode_lsp: {
            type: "http",
            url: `http://${host}:${port}/mcp`,
            headers: {
              Authorization: `Bearer ${token}`
            }
          }
        }
      },
      null,
      2
    );
  }

  private currentConnectionValues(): { host: string; port: number; token: string } {
    const host = this.connectionInfo?.host ?? DEFAULT_HOST;
    const port = this.connectionInfo?.port ?? DEFAULT_PORT;
    const token = this.connectionInfo?.token ?? "<start-the-bridge-first>";

    return { host, port, token };
  }

  private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    try {
      if (request.method === "GET" && request.url === "/health") {
        this.writeJson(response, 200, {
          ok: true,
          running: this.isRunning,
          version: BRIDGE_VERSION,
          mcp: "/mcp",
          role: this.role,
          activeWorkspace: this.activeWorkspaceSummary(),
          workspaceCount: this.role === "gateway" ? this.registeredWorkspaces.size : undefined
        });
        return;
      }

      const requestPath = request.url?.split("?", 1)[0];

      if (requestPath?.startsWith("/gateway/")) {
        if (!this.isAuthorized(request)) {
          this.writeJson(response, 401, { ok: false, error: "Unauthorized" });
          return;
        }

        await this.handleGatewayRequest(requestPath, request, response);
        return;
      }

      if (requestPath === "/mcp") {
        if (!this.isAuthorized(request)) {
          this.writeMcpError(response, 401, -32001, "Unauthorized");
          return;
        }

        await this.handleGatewayMcpRequest(request, response);
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
      const backend = this.activeRemoteWorkspace();
      if (backend) {
        await this.proxyRequestToWorkspace(request, response, backend, body, { mcp: false });
        return;
      }

      const allowWrites = vscode.workspace
        .getConfiguration("vscodeLspMcpBridge")
        .get<boolean>("enableWriteTools", false);

      const result = await runLanguageTool(body.name, body.args ?? {}, { allowWrites });
      this.writeJson(response, 200, { ok: true, result } satisfies BridgeToolResponse);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }

      this.writeJson(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      } satisfies BridgeToolResponse);
    }
  }

  private async handleGatewayMcpRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> {
    const method = request.method?.toUpperCase();
    const sessionId = this.getHeader(request, "mcp-session-id");

    if (this.role === "gateway" && sessionId) {
      const backendId = this.mcpSessionRoutes.get(sessionId);
      if (backendId) {
        const backend = this.registeredWorkspaces.get(backendId);
        if (!backend || backend.isLocal) {
          this.mcpSessionRoutes.delete(sessionId);
          this.writeMcpError(response, 404, -32000, "MCP workspace session is no longer available.");
          return;
        }

        await this.proxyRequestToWorkspace(request, response, backend, undefined, { mcp: true });
        if (method === "DELETE") {
          this.mcpSessionRoutes.delete(sessionId);
        }
        return;
      }
    }

    if (this.role === "gateway" && method === "POST" && !sessionId) {
      const body = await this.readJson<unknown>(request);
      const backend = isInitializeRequest(body) ? this.activeRemoteWorkspace() : undefined;
      if (backend) {
        await this.proxyRequestToWorkspace(request, response, backend, body, { mcp: true });
        return;
      }

      await this.handleMcpRequest(request, response, body);
      return;
    }

    await this.handleMcpRequest(request, response);
  }

  private async handleMcpRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    preReadBody?: unknown
  ): Promise<void> {
    const method = request.method?.toUpperCase();
    const sessionId = this.getHeader(request, "mcp-session-id");

    if (method === "POST") {
      const body = preReadBody ?? (await this.readJson<unknown>(request));

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

  private async startWorkerBehindGateway(host: string, gatewayPort: number): Promise<void> {
    try {
      const gatewayConnection = await this.readConnectionFile();
      const gatewayToken = gatewayConnection?.token;
      if (!gatewayToken) {
        throw new Error(
          `Port ${gatewayPort} is busy, but no existing VS Code LSP MCP Bridge gateway token was found in the connection file.`
        );
      }

      await this.listen(0, host);
      const workerPort = this.listeningPort();
      this.role = "worker";
      this.actualPort = workerPort;
      this.gatewayEndpoint = { host, port: gatewayPort, token: gatewayToken };
      this.connectionInfo = {
        version: BRIDGE_VERSION,
        host,
        port: gatewayPort,
        token: gatewayToken,
        workspaceFolders: vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [],
        createdAt: new Date().toISOString()
      };

      await this.refreshGatewayRegistration(true);
      await this.writeConnectionFile();
      this.startRegistrationHeartbeat();
      vscode.window.showInformationMessage(
        `VS Code LSP MCP Bridge registered this workspace with the gateway at http://${host}:${gatewayPort}/mcp.`
      );
    } catch (error) {
      await this.resetAfterFailedStart();
      throw error;
    }
  }

  async useThisWorkspace(): Promise<string> {
    await this.start();

    if (!this.connectionInfo || !this.workspaceId) {
      throw new Error("VS Code LSP MCP Bridge is not initialized.");
    }

    if (this.role === "gateway") {
      this.registerLocalWorkspace(this.connectionInfo.host, this.connectionInfo.port, this.connectionInfo.token);
      return `VS Code LSP MCP Bridge gateway now routes MCP sessions to ${this.workspaceDisplayName()}.`;
    }

    await this.refreshGatewayRegistration(true);
    return `VS Code LSP MCP Bridge gateway now routes MCP sessions to ${this.workspaceDisplayName()}.`;
  }

  private async handleGatewayRequest(
    requestPath: string,
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> {
    if (this.role !== "gateway") {
      this.writeJson(response, 409, { ok: false, error: "This bridge instance is not the gateway." });
      return;
    }

    if (request.method === "POST" && requestPath === "/gateway/register") {
      const registration = await this.readJson<WorkspaceRegistration>(request);
      this.registerRemoteWorkspace(registration);
      this.writeJson(response, 200, {
        ok: true,
        activeWorkspace: this.activeWorkspaceSummary(),
        workspaceCount: this.registeredWorkspaces.size
      });
      return;
    }

    if (request.method === "POST" && requestPath === "/gateway/unregister") {
      const body = await this.readJson<{ id?: string }>(request);
      if (body.id) {
        this.removeRegisteredWorkspace(body.id);
      }

      this.writeJson(response, 200, {
        ok: true,
        activeWorkspace: this.activeWorkspaceSummary(),
        workspaceCount: this.registeredWorkspaces.size
      });
      return;
    }

    if (request.method === "GET" && requestPath === "/gateway/workspaces") {
      this.expireStaleWorkspaces();
      this.writeJson(response, 200, {
        ok: true,
        activeWorkspace: this.activeWorkspaceSummary(),
        workspaces: [...this.registeredWorkspaces.values()].map(workspace => this.workspaceSummary(workspace))
      });
      return;
    }

    this.writeJson(response, 404, { ok: false, error: "Not found" });
  }

  private registerLocalWorkspace(host: string, port: number, token: string): void {
    const registration = this.createWorkspaceRegistration(host, port, token, true);
    this.registeredWorkspaces.set(registration.id, {
      ...registration,
      isLocal: true,
      lastSeenAt: new Date().toISOString()
    });
    this.activeWorkspaceId = registration.id;
  }

  private registerRemoteWorkspace(registration: WorkspaceRegistration): void {
    if (!registration.id || !registration.host || !registration.port || !registration.token) {
      throw new Error("Invalid bridge workspace registration.");
    }

    this.expireStaleWorkspaces();
    this.registeredWorkspaces.set(registration.id, {
      ...registration,
      isLocal: false,
      lastSeenAt: new Date().toISOString()
    });

    if (registration.activate || !this.activeWorkspaceId) {
      this.activeWorkspaceId = registration.id;
    }
  }

  private removeRegisteredWorkspace(id: string): void {
    this.registeredWorkspaces.delete(id);
    this.removeSessionRoutesForWorkspace(id);

    if (this.activeWorkspaceId === id) {
      this.activeWorkspaceId = this.workspaceId && this.registeredWorkspaces.has(this.workspaceId)
        ? this.workspaceId
        : this.registeredWorkspaces.keys().next().value;
    }
  }

  private activeRemoteWorkspace(): RegisteredWorkspace | undefined {
    if (this.role !== "gateway") {
      return undefined;
    }

    this.expireStaleWorkspaces();
    if (!this.activeWorkspaceId || this.activeWorkspaceId === this.workspaceId) {
      return undefined;
    }

    const activeWorkspace = this.registeredWorkspaces.get(this.activeWorkspaceId);
    return activeWorkspace && !activeWorkspace.isLocal ? activeWorkspace : undefined;
  }

  private activeWorkspaceSummary(): object | undefined {
    if (this.role !== "gateway" || !this.activeWorkspaceId) {
      return undefined;
    }

    const activeWorkspace = this.registeredWorkspaces.get(this.activeWorkspaceId);
    return activeWorkspace ? this.workspaceSummary(activeWorkspace) : undefined;
  }

  private workspaceSummary(workspace: RegisteredWorkspace): object {
    return {
      id: workspace.id,
      name: workspace.name,
      active: workspace.id === this.activeWorkspaceId,
      local: workspace.isLocal,
      workspaceFolders: workspace.workspaceFolders.length,
      lastSeenAt: workspace.lastSeenAt
    };
  }

  private createWorkspaceRegistration(
    host: string,
    port: number,
    token: string,
    activate: boolean
  ): WorkspaceRegistration {
    return {
      id: this.workspaceId ?? this.createWorkspaceId(),
      name: this.workspaceDisplayName(),
      host,
      port,
      token,
      workspaceFolders: vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [],
      startedAt: new Date().toISOString(),
      activate
    };
  }

  private createWorkspaceId(): string {
    const workspaceFolders = vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [];
    const idSource = workspaceFolders.length > 0 ? workspaceFolders.join("\0") : "no-workspace";
    return crypto.createHash("sha256").update(idSource).digest("hex").slice(0, 16);
  }

  private workspaceDisplayName(): string {
    const firstFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return vscode.workspace.name ?? (firstFolder ? path.basename(firstFolder) : "No workspace");
  }

  private expireStaleWorkspaces(): void {
    if (this.role !== "gateway") {
      return;
    }

    const now = Date.now();
    for (const workspace of this.registeredWorkspaces.values()) {
      if (!workspace.isLocal && now - Date.parse(workspace.lastSeenAt) > registrationStaleMs) {
        this.removeRegisteredWorkspace(workspace.id);
      }
    }
  }

  private removeSessionRoutesForWorkspace(workspaceId: string): void {
    for (const [sessionId, routedWorkspaceId] of this.mcpSessionRoutes.entries()) {
      if (routedWorkspaceId === workspaceId) {
        this.mcpSessionRoutes.delete(sessionId);
      }
    }
  }

  private async refreshGatewayRegistration(activate: boolean): Promise<void> {
    if (!this.gatewayEndpoint || this.actualPort === undefined) {
      return;
    }

    const registration = this.createWorkspaceRegistration(
      this.gatewayEndpoint.host,
      this.actualPort,
      this.gatewayEndpoint.token,
      activate
    );

    await this.postJsonToGateway("/gateway/register", registration);
  }

  private async unregisterFromGateway(): Promise<void> {
    if (!this.gatewayEndpoint || !this.workspaceId) {
      return;
    }

    await this.postJsonToGateway("/gateway/unregister", { id: this.workspaceId });
  }

  private startRegistrationHeartbeat(): void {
    this.stopRegistrationHeartbeat();
    this.registrationTimer = setInterval(() => {
      void this.refreshGatewayRegistration(false).catch(error => {
        console.warn("VS Code LSP MCP Bridge gateway registration refresh failed.", error);
        void this.promoteWorkerIfGatewayDisappeared();
      });
    }, registrationRefreshMs);
  }

  private stopRegistrationHeartbeat(): void {
    if (this.registrationTimer) {
      clearInterval(this.registrationTimer);
      this.registrationTimer = undefined;
    }
  }

  private async promoteWorkerIfGatewayDisappeared(): Promise<void> {
    if (this.role !== "worker" || this.isPromoting) {
      return;
    }

    this.isPromoting = true;
    try {
      const server = this.server;
      this.server = undefined;
      this.connectionInfo = undefined;
      this.role = undefined;
      this.actualPort = undefined;
      this.gatewayEndpoint = undefined;
      this.stopRegistrationHeartbeat();
      await this.closeMcpSessions();

      if (server) {
        await this.closeHttpServer(server).catch(() => undefined);
      }

      await this.start();
    } catch (error) {
      console.warn("VS Code LSP MCP Bridge worker promotion failed.", error);
    } finally {
      this.isPromoting = false;
    }
  }

  private async postJsonToGateway(pathname: string, body: unknown): Promise<void> {
    if (!this.gatewayEndpoint) {
      throw new Error("Gateway endpoint is not initialized.");
    }

    const payload = JSON.stringify(body);
    await this.requestJson({
      host: this.gatewayEndpoint.host,
      port: this.gatewayEndpoint.port,
      path: pathname,
      method: "POST",
      headers: {
        authorization: `Bearer ${this.gatewayEndpoint.token}`,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload)
      }
    }, payload);
  }

  private async proxyRequestToWorkspace(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    workspace: RegisteredWorkspace,
    body: unknown,
    options: { mcp: boolean }
  ): Promise<void> {
    try {
      await this.proxyRequest(request, response, workspace, body);
    } catch (error) {
      this.removeRegisteredWorkspace(workspace.id);
      if (response.headersSent) {
        response.destroy();
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      if (options.mcp) {
        this.writeMcpError(response, 502, -32000, `MCP workspace proxy failed: ${message}`);
      } else {
        this.writeJson(response, 502, { ok: false, error: `Workspace proxy failed: ${message}` });
      }
    }
  }

  private async proxyRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    workspace: RegisteredWorkspace,
    body: unknown
  ): Promise<void> {
    const method = request.method ?? "GET";
    const sessionId = this.getHeader(request, "mcp-session-id");
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: http.OutgoingHttpHeaders = {
      authorization: `Bearer ${workspace.token}`,
      accept: request.headers.accept ?? "application/json, text/event-stream"
    };

    if (sessionId) {
      headers["mcp-session-id"] = sessionId;
    }

    if (payload !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(payload);
    }

    await new Promise<void>((resolve, reject) => {
      const proxyRequest = http.request(
        {
          host: workspace.host,
          port: workspace.port,
          path: request.url ?? "/mcp",
          method,
          headers
        },
        proxyResponse => {
          const proxiedSessionId = this.firstHeaderValue(proxyResponse.headers["mcp-session-id"]);
          if (proxiedSessionId) {
            this.mcpSessionRoutes.set(proxiedSessionId, workspace.id);
          }

          response.writeHead(proxyResponse.statusCode ?? 502, this.outgoingHeaders(proxyResponse.headers));
          proxyResponse.pipe(response);
          proxyResponse.on("end", resolve);
        }
      );

      proxyRequest.on("error", reject);
      if (method.toUpperCase() !== "GET") {
        proxyRequest.setTimeout(15_000, () => {
          proxyRequest.destroy(new Error("Timed out while proxying to workspace bridge."));
        });
      }

      if (payload !== undefined) {
        proxyRequest.write(payload);
      }
      proxyRequest.end();
    });
  }

  private async requestJson(options: http.RequestOptions, payload: string): Promise<unknown> {
    return await new Promise<unknown>((resolve, reject) => {
      const request = http.request(options, response => {
        const chunks: Buffer[] = [];
        response.on("data", chunk => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
            reject(new Error(text || `HTTP ${response.statusCode}`));
            return;
          }

          resolve(text ? JSON.parse(text) : {});
        });
      });

      request.on("error", reject);
      request.setTimeout(5_000, () => {
        request.destroy(new Error("Timed out while contacting the bridge gateway."));
      });
      request.write(payload);
      request.end();
    });
  }

  private async readConnectionFile(): Promise<BridgeConnectionInfo | undefined> {
    if (!this.connectionFile) {
      return undefined;
    }

    try {
      return JSON.parse(await fs.readFile(this.connectionFile, "utf8")) as BridgeConnectionInfo;
    } catch {
      return undefined;
    }
  }

  private outgoingHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
    const outgoing: http.OutgoingHttpHeaders = {};
    for (const [key, value] of Object.entries(headers)) {
      if (value !== undefined) {
        outgoing[key] = value;
      }
    }

    return outgoing;
  }

  private firstHeaderValue(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
  }

  private async resetAfterFailedStart(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.connectionInfo = undefined;
    this.connectionFile = undefined;
    this.role = undefined;
    this.workspaceId = undefined;
    this.actualPort = undefined;
    this.gatewayEndpoint = undefined;
    this.activeWorkspaceId = undefined;
    this.registeredWorkspaces.clear();
    this.mcpSessionRoutes.clear();

    if (server?.listening) {
      await this.closeHttpServer(server).catch(() => undefined);
    }
  }

  private async listen(port: number, host: string): Promise<void> {
    const server = this.server;
    if (!server) {
      throw new Error("Bridge HTTP server is not initialized.");
    }

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        server.off("error", onError);
        server.off("listening", onListening);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onListening = () => {
        cleanup();
        resolve();
      };

      server.once("error", onError);
      server.once("listening", onListening);
      try {
        server.listen(port, host);
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  private listeningPort(): number {
    const address = this.server?.address();
    if (address && typeof address !== "string") {
      return address.port;
    }

    throw new Error("Bridge HTTP server is not listening on a TCP port.");
  }

  private isAddressInUseError(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "EADDRINUSE";
  }

  private async closeHttpServer(server: http.Server): Promise<void> {
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
