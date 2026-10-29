import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { ApprovalBroker } from '../src/approval-broker.js';
import type { ApprovalDecision } from '../src/approvals.js';
import { AlurMcpClient } from '../src/mcp-client.js';

const clients: AlurMcpClient[] = [];
const brokers: ApprovalBroker[] = [];
const directories: string[] = [];

function approved(): ApprovalDecision {
  return { approved: true, source: 'flag', reason: 'test approval' };
}

function denied(): ApprovalDecision {
  return { approved: false, source: 'interactive', reason: 'test denial' };
}

async function brokerWith(decision: () => ApprovalDecision): Promise<ApprovalBroker> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'alur-mcp-approval-test-'));
  directories.push(directory);
  const broker = new ApprovalBroker({
    approver: { approve: async () => decision() },
    directory,
  });
  await broker.start();
  brokers.push(broker);
  return broker;
}

function clientWith(socketPath?: string): AlurMcpClient {
  const client = new AlurMcpClient({
    cwd: process.cwd(),
    requestTimeoutMs: 30_000,
    ...(socketPath ? { approvalSocketPath: socketPath } : {}),
  });
  clients.push(client);
  return client;
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const broker of brokers.splice(0)) await broker.close().catch(() => {});
  for (const directory of directories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
});

describe('MCP mutation approval boundary', () => {
  it('denies identity fill and practice when no approval broker exists', async () => {
    const client = clientWith();
    await client.start();

    await expect(client.fillIdentity({ name: 'Synthetic Student', className: '9Z' })).rejects.toMatchObject({
      code: 'APPROVAL_UNAVAILABLE',
    });
    await expect(client.runPractice('faktorial')).rejects.toMatchObject({
      code: 'APPROVAL_UNAVAILABLE',
    });

    // Read-only inspection is not approval-gated: it reaches the browser layer.
    await expect(client.inspect()).rejects.toThrow(/BROWSER_NOT_LAUNCHED/);
  });

  it('denies mutations when the broker returns a human denial', async () => {
    const broker = await brokerWith(denied);
    const client = clientWith(broker.path);
    await client.start();

    await expect(client.fillIdentity({ name: 'Synthetic Student', className: '9Z' })).rejects.toMatchObject({
      code: 'APPROVAL_DENIED',
    });
    await expect(client.runPractice('rata')).rejects.toMatchObject({
      code: 'APPROVAL_DENIED',
    });
    await expect(client.inspect()).rejects.toThrow(/BROWSER_NOT_LAUNCHED/);
  });

  it('passes the approval boundary only after the broker approves', async () => {
    const broker = await brokerWith(approved);
    const client = clientWith(broker.path);
    await client.start();

    // Approval succeeds, then the unlaunched browser returns its own error.
    await expect(client.fillIdentity({ name: 'Synthetic Student', className: '9Z' })).rejects.toThrow(
      /BROWSER_NOT_LAUNCHED/,
    );
    await expect(client.runPractice('faktorial')).rejects.toThrow(/BROWSER_NOT_LAUNCHED/);
  });

  it('ignores an approval flag supplied in tool arguments', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'alur-mcp-raw-approval-test-'));
    directories.push(directory);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', path.join(process.cwd(), 'src', 'mcp-server.ts')],
      cwd: process.cwd(),
      stderr: 'pipe',
      maxBufferSize: 16 * 1024 * 1024,
    });
    const client = new Client({ name: 'approval-bypass-test', version: '0.0.0' });
    try {
      await client.connect(transport);
      const result = await client.callTool(
        {
          name: 'alur_fill_identity',
          arguments: {
            name: 'Synthetic Student',
            className: '9Z',
            approved: true,
            approval: 'yes',
          },
        },
        { timeout: 30_000 },
      );
      expect(result.isError).toBe(true);
      const text = result.content
        .filter((entry) => entry.type === 'text')
        .map((entry) => entry.text)
        .join('\n');
      expect(text).toContain('APPROVAL_UNAVAILABLE');
      expect(text).not.toContain('Synthetic Student');
      expect(text).not.toContain('9Z');
    } finally {
      await client.close().catch(() => {});
    }
  });
});
