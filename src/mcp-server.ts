#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { requestMutationApproval } from './approval-broker.js';
import { FirefoxBrowser } from './browser.js';
import { ALUR_VIEWS, DEFAULT_ALUR_URL } from './site.js';
import { clip, sanitizeError } from './redact.js';

const VIEW_SCHEMA = z.enum(ALUR_VIEWS);
const EXAMPLE_SCHEMA = z.enum(['faktorial', 'rata']);
const IDENTITY_SCHEMA = z.object({
  name: z.string().trim().min(1).max(80).describe('Student name exactly as configured by the local operator.'),
  className: z.string().trim().min(1).max(20).describe('Student class exactly as configured by the local operator.'),
});

const activeBrowsers = new Set<FirefoxBrowser>();

function log(message: string, error?: unknown): void {
  const suffix = error === undefined ? '' : `: ${sanitizeError(error).message}`;
  process.stderr.write(`[alur-mcp] ${clip(message, 500)}${clip(suffix, 1_000)}\n`);
}

function text(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function failure(error: unknown): {
  isError: true;
  content: Array<{ type: 'text'; text: string }>;
} {
  const details = sanitizeError(error);
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: details }) }],
  };
}

function browser(): FirefoxBrowser {
  const instance = new FirefoxBrowser({ headless: false, alurUrl: DEFAULT_ALUR_URL });
  activeBrowsers.add(instance);
  return instance;
}

async function closeBrowser(instance: FirefoxBrowser): Promise<void> {
  await instance.close();
  activeBrowsers.delete(instance);
}

async function authorizeMutation(
  stage: string,
  action: string,
  details: string[],
): Promise<void> {
  // Approval is checked inside the MCP server, immediately before the browser
  // mutation. It is never accepted from an MCP tool argument.
  await requestMutationApproval({ stage, action, details });
}

export interface CreateServerOptions {
  browserInstance?: FirefoxBrowser;
}

/**
 * Least-privilege ALUR MCP server. It exposes only fixed Firefox/ALUR steps and
 * one built-in practice example runner. It has no shell, filesystem, arbitrary
 * URL, mission, quiz, or submission tool. Stdout is reserved for MCP framing.
 */
export function createAlurMcpServer(options: CreateServerOptions = {}): McpServer {
  const instance = options.browserInstance ?? browser();

  const server = new McpServer(
    { name: 'alur-firefox', version: '0.1.0' },
    {
      instructions:
        'Local, least-privilege Firefox tools for the official ALUR page. Only the built-in ungraded practice examples may be run. Never use these tools for graded missions or submissions. Complete only after the deterministic verifier proves it.',
      maxToolInputElements: 1_000,
    },
  );

  server.registerTool(
    'firefox_launch',
    {
      title: 'Launch Playwright Firefox',
      description: 'Launch an isolated Playwright Firefox browser. Chromium and executable overrides are not supported.',
      inputSchema: z.object({
        headless: z.boolean().default(false).describe('Run Firefox without a visible window.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ headless }) => {
      try {
        return text(await instance.launch(headless));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'alur_open',
    {
      title: 'Open official ALUR',
      description: 'Open the hard-coded official ALUR URL and verify the page identity. No URL argument is accepted.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      try {
        return text(await instance.open());
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'alur_inspect',
    {
      title: 'Inspect ALUR state',
      description: 'Read a sanitized snapshot of the official ALUR page: tabs, Lab status/console, identity field metadata, and mission labels. It does not include typed identity values.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return text(await instance.inspect());
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'alur_open_view',
    {
      title: 'Open ALUR tab',
      description: 'Switch to one of the fixed ALUR tabs: lab, rakit, susun, misi, or notasi.',
      inputSchema: z.object({ view: VIEW_SCHEMA }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ view }) => {
      try {
        return text(await instance.openView(view));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'alur_fill_identity',
    {
      title: 'Fill ALUR identity',
      description:
        'Open the Misi tab and fill only the name (Nama) and class (Kelas) fields, then verify inputs and localStorage. Requires a local approval broker; tool arguments cannot grant approval. Values are not logged or returned.',
      inputSchema: IDENTITY_SCHEMA,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ name, className }) => {
      try {
        await authorizeMutation(
          'fill-identity',
          'Fill the configured Nama and Kelas fields in the Misi tab',
          [
            'Only the two identity inputs will be changed.',
            'No mission, quiz, trace table, or submission will be touched.',
            'Identity values are supplied by the MCP caller and are never logged here.',
          ],
        );
        return text(await instance.fillConfiguredIdentity({ name, className }));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'alur_verify_identity',
    {
      title: 'Verify ALUR identity',
      description: 'Re-read the Misi identity fields and localStorage to verify configured values without returning the values.',
      inputSchema: IDENTITY_SCHEMA,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ name, className }) => {
      try {
        return text(await instance.verifyConfiguredIdentity({ name, className }));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'alur_run_practice',
    {
      title: 'Run built-in practice example',
      description:
        'Run exactly one built-in ungraded ALUR demo in the Lab, after loading its untouched source/inputs, resetting state, and waiting for a terminal status. Requires a local approval broker; tool arguments cannot grant approval. Graded missions are not exposed.',
      inputSchema: z.object({ example: EXAMPLE_SCHEMA }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ example }) => {
      try {
        await authorizeMutation(
          'run-practice',
          'Run one built-in ungraded practice example',
          [
            `Example id: ${example}`,
            'The built-in source is loaded unchanged, then reset, then run with the site UI.',
            'This is not a graded mission and nothing is submitted.',
          ],
        );
        return text(await instance.runPractice(example));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'alur_screenshot',
    {
      title: 'Capture ALUR evidence',
      description:
        'Capture a PNG of the current official ALUR Lab view, preferring a full-page image with a bounded viewport fallback. Refuses if another tab or a graded mission is active. Returns MCP image content plus dimensions/hash metadata.',
      inputSchema: z.object({ fullPage: z.boolean().default(true) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ fullPage }) => {
      try {
        const capture = await instance.captureScreenshot(fullPage);
        return {
          content: [
            {
              type: 'image' as const,
              data: capture.buffer.toString('base64'),
              mimeType: 'image/png',
            },
            {
              type: 'text' as const,
              text: JSON.stringify({
                mimeType: 'image/png',
                bytes: capture.buffer.length,
                fullPage: capture.fullPage,
                width: capture.width,
                height: capture.height,
                fallbackReason: capture.fallbackReason,
              }),
            },
          ],
        };
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'firefox_close',
    {
      title: 'Close Firefox',
      description: 'Close the isolated Playwright Firefox browser and release resources.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        await closeBrowser(instance);
        return text({ closed: true });
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}

async function main(): Promise<void> {
  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    log(`Received ${signal}; closing browser(s).`);
    await Promise.allSettled([...activeBrowsers].map((entry) => closeBrowser(entry)));
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  const server = createAlurMcpServer();
  const transport = new StdioServerTransport(undefined, undefined, { maxBufferSize: 16 * 1024 * 1024 });
  transport.onclose = () => {
    void Promise.allSettled([...activeBrowsers].map((entry) => closeBrowser(entry)));
  };
  transport.onerror = (error) => log('MCP transport error', error);
  await server.connect(transport);
  log('ALUR MCP server ready on stdio.');
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath && path.resolve(modulePath) === invokedPath) {
  await main().catch((error: unknown) => {
    log('Fatal server error', error);
    process.exit(1);
  });
}
