import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApprovalBroker } from '../../src/approval-broker.js';
import { evaluatePracticeCompletion } from '../../src/completion.js';
import { Logger } from '../../src/logger.js';
import { AlurMcpClient } from '../../src/mcp-client.js';

const live = process.env.RUN_LIVE_ALUR === '1';

describe.skipIf(!live)('live ALUR MCP integration', () => {
  let directory: string;
  let logger: Logger;
  let client: AlurMcpClient | null = null;
  let broker: ApprovalBroker | null = null;

  beforeAll(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'alur-live-test-'));
    logger = new Logger({ dir: path.join(directory, 'logs'), runId: `live-${Date.now()}`, mode: 'test', terminal: false });
  });

  afterAll(async () => {
    await client?.close().catch(() => {});
    await broker?.close().catch(() => {});
    logger.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it(
    'uses the fixed Firefox MCP tools to fill identity, run faktorial, verify it, and capture PNG evidence',
    { timeout: 120_000 },
    async () => {
      broker = new ApprovalBroker({
        approver: {
          approve: async () => ({ approved: true, source: 'flag', reason: 'live test approval' }),
        },
        logger,
      });
      await broker.start();
      client = new AlurMcpClient({
        cwd: process.cwd(),
        logger,
        requestTimeoutMs: 90_000,
        approvalSocketPath: broker.path,
      });
      await client.start();
      await client.launch(true);
      const opened = await client.open();
      expect(opened.url).toBe('https://ramli-labs.github.io/ALUR/');

      const before = await client.inspect();
      expect(before.bootstrapped).toBe(true);
      expect(before.mission.active).toBe(false);
      expect(before.identity.problems).toEqual([]);

      await client.openView('misi');
      const filled = await client.fillIdentity({ name: 'ALUR Agent Test', className: '9C' });
      expect(filled.verified).toBe(true);
      expect(filled.storageMatch).toBe(true);
      const verified = await client.verifyIdentity({ name: 'ALUR Agent Test', className: '9C' });
      expect(verified.verified).toBe(true);

      // Identity is visible in Misi. Evidence capture must refuse until Lab is
      // active, so a direct MCP screenshot call cannot persist the form.
      await expect(client.screenshot(true)).rejects.toThrow(/SCREENSHOT_NOT_LAB/);

      await client.openView('lab');
      const evidence = await client.runPractice('faktorial');
      const completion = evaluatePracticeCompletion(evidence);
      expect(completion.state, completion.reasons.join(' ')).toBe('VERIFIED');

      const screenshot = await client.screenshot(true);
      expect(screenshot.buffer.subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
      expect(screenshot.buffer.length).toBeGreaterThan(1_000);
      expect(screenshot.fullPage).toBe(true);

      const logText = await fs.readFile(logger.logFile, 'utf8');
      expect(logText).not.toContain('ALUR Agent Test');

      await client.close();
      client = null;
    },
  );
});
