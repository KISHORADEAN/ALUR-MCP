import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import * as z from 'zod/v4';
import { APPROVAL_SOCKET_ENV } from './approval-broker.js';
import { clip, sanitizeError } from './redact.js';
import type { Logger } from './logger.js';
import type { AlurView, PracticeExample } from './site.js';
import type {
  IdentityVerification,
  PageInspection,
  PracticeRunEvidence,
} from './types.js';
import type { ScreenshotCapture } from './screenshot.js';
import type { AlurAutomationPort } from './workflow.js';

const EXPECTED_TOOLS = [
  'firefox_launch',
  'alur_open',
  'alur_inspect',
  'alur_open_view',
  'alur_fill_identity',
  'alur_verify_identity',
  'alur_run_practice',
  'alur_screenshot',
  'firefox_close',
] as const;

type AlurToolName = (typeof EXPECTED_TOOLS)[number];

const identitySchema = z
  .object({
    verified: z.boolean(),
    valuesMatch: z.boolean(),
    storageMatch: z.boolean(),
    fields: z.array(
      z
        .object({
          key: z.enum(['name', 'class']),
          label: z.string(),
          selector: z.string(),
          id: z.string(),
          inputType: z.string(),
          visible: z.boolean(),
          valueLength: z.number(),
          storageKey: z.string(),
        })
        .passthrough(),
    ),
    problems: z.array(z.string()),
  })
  .passthrough();

const pageInspectionSchema = z
  .object({
    url: z.string(),
    title: z.string(),
    view: z.string(),
    bootstrapped: z.boolean(),
    navTabs: z.array(z.object({ view: z.string(), label: z.string(), selected: z.boolean() }).passthrough()),
    identity: z
      .object({
        fields: z.array(z.unknown()),
        nameStored: z.boolean(),
        classStored: z.boolean(),
        bothVisible: z.boolean(),
        problems: z.array(z.string()),
      })
      .passthrough(),
    lab: z
      .object({
        status: z.object({ state: z.string(), text: z.string() }).passthrough(),
        consoleOutput: z.array(z.string()),
        consoleEntryCount: z.number(),
        error: z.object({ visible: z.boolean(), text: z.string() }).passthrough(),
        editor: z
          .object({
            present: z.boolean(),
            length: z.number(),
            knownPracticeSignatures: z.array(z.string()),
          })
          .passthrough(),
        inputsLength: z.number(),
        examples: z.array(z.object({ id: z.string(), title: z.string() }).passthrough()),
      })
      .passthrough(),
    mission: z
      .object({
        active: z.boolean(),
        countText: z.string(),
        selected: z.unknown().nullable(),
        summary: z.unknown().nullable(),
        cards: z.array(z.unknown()),
      })
      .passthrough(),
    pageErrors: z.array(z.string()),
  })
  .passthrough();

const practiceEvidenceSchema = z
  .object({
    exampleId: z.string(),
    expectedInputs: z.string(),
    expectedConsoleLines: z.array(z.string()),
    startedAt: z.string(),
    finishedAt: z.string(),
    durationMs: z.number(),
    url: z.string(),
    view: z.string(),
    codeSignatureMatched: z.boolean(),
    inputsValue: z.string(),
    status: z.object({ state: z.string(), text: z.string() }).passthrough(),
    consoleOutput: z.array(z.string()),
    consoleEntryCount: z.number(),
    error: z.object({ visible: z.boolean(), text: z.string() }).passthrough(),
    timedOut: z.boolean(),
    pageErrors: z.array(z.string()),
  })
  .passthrough();

const screenshotMetadataSchema = z
  .object({
    mimeType: z.literal('image/png'),
    bytes: z.number(),
    fullPage: z.boolean(),
    width: z.number().nullable(),
    height: z.number().nullable(),
    fallbackReason: z.string().nullable(),
  })
  .passthrough();

export class McpClientError extends Error {
  readonly code: string;
  readonly tool: string | null;

  constructor(code: string, message: string, tool: string | null = null) {
    super(message);
    this.name = 'McpClientError';
    this.code = code;
    this.tool = tool;
  }
}

interface McpClientOptions {
  cwd: string;
  logger?: Logger;
  serverEntry?: string;
  requestTimeoutMs?: number;
  approvalSocketPath?: string;
}

export class AlurMcpClient implements AlurAutomationPort {
  private readonly options: McpClientOptions;
  private readonly logger?: Logger;
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private stderr = '';
  private connected = false;

  constructor(options: McpClientOptions) {
    this.options = options;
    this.logger = options.logger;
  }

  async start(): Promise<void> {
    if (this.connected) return;
    const entry = this.options.serverEntry ?? path.join(this.options.cwd, 'src', 'mcp-server.ts');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', entry],
      cwd: this.options.cwd,
      stderr: 'pipe',
      // The SDK inherits only a small allowlist by default. Pass the broker
      // socket path explicitly and never forward OPENROUTER_API_KEY.
      env: this.options.approvalSocketPath
        ? { [APPROVAL_SOCKET_ENV]: this.options.approvalSocketPath }
        : {},
      maxBufferSize: 16 * 1024 * 1024,
    });
    this.transport = transport;

    transport.stderr?.on('data', (chunk: Buffer | string) => {
      const message = clip(String(chunk), 1_500);
      this.stderr = clip(`${this.stderr}${message}`, 8_000);
      this.logger?.server('debug', `MCP server: ${message}`);
    });

    const client = new Client({ name: 'alur-agent', version: '0.1.0' });
    try {
      await client.connect(transport);
      this.client = client;
      this.connected = true;
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      const actual = [...names].sort();
      const expected = [...EXPECTED_TOOLS].sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new McpClientError(
          'TOOL_CATALOG_MISMATCH',
          `The MCP server exposed an unexpected tool catalog. Expected: ${expected.join(', ')}. Got: ${actual.join(', ')}.`,
        );
      }
      this.logger?.info(`MCP connected with ${names.length} fixed ALUR tools.`);
    } catch (error) {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      this.client = null;
      this.transport = null;
      this.connected = false;
      const details = sanitizeError(error);
      const stderr = this.getStderr();
      throw new McpClientError(
        'MCP_START_FAILED',
        `Could not start the ALUR MCP server: ${details.message}${stderr ? ` Server stderr: ${stderr}` : ''}`,
      );
    }
  }

  async launch(headless: boolean): Promise<{ browser: 'firefox'; headless: boolean }> {
    const response = await this.callTool<{ browser: string; headless: boolean }>('firefox_launch', { headless });
    if (response.browser !== 'firefox') {
      throw new McpClientError('WRONG_BROWSER', `The MCP server launched "${response.browser}", not Firefox.`);
    }
    return { browser: 'firefox', headless: response.headless };
  }

  async open(): Promise<{ url: string; title: string }> {
    const response = await this.callTool<{ url: string; title: string }>('alur_open', {});
    return { url: String(response.url), title: String(response.title) };
  }

  async inspect(): Promise<PageInspection> {
    return this.callTool('alur_inspect', {}, pageInspectionSchema) as Promise<PageInspection>;
  }

  async openView(view: AlurView): Promise<{ view: AlurView; visible: boolean }> {
    const response = await this.callTool<{ view: string; visible: boolean }>('alur_open_view', { view });
    return { view: response.view as AlurView, visible: response.visible };
  }

  async fillIdentity(expected: { name: string; className: string }): Promise<IdentityVerification> {
    return this.callTool(
      'alur_fill_identity',
      { name: expected.name, className: expected.className },
      identitySchema,
    ) as Promise<IdentityVerification>;
  }

  async verifyIdentity(expected: { name: string; className: string }): Promise<IdentityVerification> {
    return this.callTool(
      'alur_verify_identity',
      { name: expected.name, className: expected.className },
      identitySchema,
    ) as Promise<IdentityVerification>;
  }

  async runPractice(example: PracticeExample['id']): Promise<PracticeRunEvidence> {
    return this.callTool('alur_run_practice', { example }, practiceEvidenceSchema) as Promise<PracticeRunEvidence>;
  }

  async screenshot(fullPage: boolean): Promise<ScreenshotCapture> {
    const result = await this.callRawTool('alur_screenshot', { fullPage });
    const image = result.content.find((entry) => entry.type === 'image');
    if (!image || image.type !== 'image' || image.mimeType !== 'image/png') {
      throw new McpClientError('SCREENSHOT_MISSING', 'The MCP screenshot tool returned no PNG image.', 'alur_screenshot');
    }
    const textBlock = result.content.find((entry) => entry.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new McpClientError('SCREENSHOT_METADATA', 'The MCP screenshot tool returned no metadata.', 'alur_screenshot');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(textBlock.text);
    } catch {
      throw new McpClientError('SCREENSHOT_METADATA', 'The MCP screenshot metadata was not valid JSON.', 'alur_screenshot');
    }
    const metadata = screenshotMetadataSchema.parse(parsed);
    const buffer = Buffer.from(image.data, 'base64');
    if (buffer.length !== metadata.bytes) {
      throw new McpClientError(
        'SCREENSHOT_TRUNCATED',
        `The screenshot image was ${buffer.length} bytes but metadata claimed ${metadata.bytes}.`,
        'alur_screenshot',
      );
    }
    return {
      buffer,
      fullPage: metadata.fullPage,
      fallbackReason: metadata.fallbackReason,
      width: metadata.width,
      height: metadata.height,
    };
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    try {
      await this.callTool('firefox_close', {}, z.object({ closed: z.boolean() }).passthrough());
    } catch (error) {
      this.logger?.warn(`Could not close Firefox through MCP: ${sanitizeError(error).message}`);
    } finally {
      const client = this.client;
      this.client = null;
      this.transport = null;
      await client?.close().catch(() => {});
    }
  }

  getStderr(): string {
    return clip(this.stderr, 4_000);
  }

  private async callTool<T = Record<string, unknown>>(
    name: AlurToolName,
    args: Record<string, unknown>,
    schema?: z.ZodType<T>,
  ): Promise<T> {
    const result = await this.callRawTool(name, args);
    const textBlock = result.content.find((entry) => entry.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new McpClientError('MCP_RESULT_SHAPE', `MCP tool ${name} returned no text result.`, name);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(textBlock.text);
    } catch {
      throw new McpClientError('MCP_RESULT_JSON', `MCP tool ${name} returned non-JSON text.`, name);
    }
    if (schema) {
      const validated = schema.safeParse(parsed);
      if (!validated.success) {
        throw new McpClientError(
          'MCP_RESULT_VALIDATION',
          `MCP tool ${name} returned an invalid result: ${validated.error.message}`,
          name,
        );
      }
      return validated.data;
    }
    return parsed as T;
  }

  private async callRawTool(
    name: AlurToolName,
    args: Record<string, unknown>,
  ): ReturnType<Client['callTool']> {
    if (!this.client) throw new McpClientError('MCP_NOT_CONNECTED', 'The ALUR MCP client is not connected.', name);
    const started = Date.now();
    try {
      const result = await this.client.callTool(
        { name, arguments: args },
        { timeout: this.options.requestTimeoutMs ?? 120_000 },
      );
      const duration = Date.now() - started;
      if (result.isError) {
        const details = result.content
          .filter((entry) => entry.type === 'text')
          .map((entry) => entry.text)
          .join('\n');
        this.logger?.tool(name, 'error', duration, details);
        let code = 'MCP_TOOL_ERROR';
        try {
          const parsed = JSON.parse(details) as { error?: { code?: unknown } };
          if (typeof parsed.error?.code === 'string' && /^[A-Z][A-Z0-9_]{2,80}$/.test(parsed.error.code)) {
            code = parsed.error.code;
          }
        } catch {
          // Keep the generic MCP error code for non-JSON failures.
        }
        throw new McpClientError(code, `MCP tool ${name} failed: ${clip(details, 1_500)}`, name);
      }
      this.logger?.tool(name, 'ok', duration);
      return result;
    } catch (error) {
      const duration = Date.now() - started;
      if (error instanceof McpClientError) throw error;
      const message = sanitizeError(error).message;
      const timeout = /timeout|timed out|RequestTimeout/i.test(message);
      this.logger?.tool(name, timeout ? 'timeout' : 'error', duration, message);
      throw new McpClientError(
        timeout ? 'MCP_TOOL_TIMEOUT' : 'MCP_CALL_FAILED',
        `MCP tool ${name} ${timeout ? 'timed out' : 'failed'}: ${message}`,
        name,
      );
    }
  }
}
