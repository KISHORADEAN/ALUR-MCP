import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { ApprovalDecision, ApprovalRequest, Approver } from './approvals.js';
import type { Logger } from './logger.js';
import { clip, sanitizeError } from './redact.js';

export const APPROVAL_SOCKET_ENV = 'ALUR_MCP_APPROVAL_SOCKET';
export const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000;

const MAX_REQUEST_BYTES = 16_384;
const MAX_RESPONSE_BYTES = 8_192;
const CONNECT_TIMEOUT_MS = 5_000;

export class ApprovalError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ApprovalError';
    this.code = code;
  }
}

export interface MutationApprovalRequest {
  stage: string;
  action: string;
  details: string[];
}

interface BrokerOptions {
  approver: Approver;
  logger?: Logger;
  directory?: string;
}

interface WireRequest extends MutationApprovalRequest {}

interface WireResponse {
  approved: boolean;
  source: string;
  reason: string;
}

function isWireRequest(value: unknown): value is WireRequest {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.stage === 'string' &&
    record.stage.length > 0 &&
    record.stage.length <= 100 &&
    typeof record.action === 'string' &&
    record.action.length > 0 &&
    record.action.length <= 300 &&
    Array.isArray(record.details) &&
    record.details.length <= 10 &&
    record.details.every((entry) => typeof entry === 'string' && entry.length <= 500)
  );
}

async function writeResponse(socket: net.Socket, response: WireResponse): Promise<void> {
  if (!socket.writable) return;
  socket.end(`${JSON.stringify(response)}\n`);
}

/**
 * Local approval broker used by the MCP server at the mutation boundary. The
 * socket lives in an owner-only temporary directory, carries no approval flag
 * in MCP tool arguments, and is only reachable by the same OS user.
 */
export class ApprovalBroker {
  private readonly options: BrokerOptions;
  private server: net.Server | null = null;
  private directory: string | null = null;
  private socketPath: string | null = null;
  private ownsDirectory = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: BrokerOptions) {
    this.options = options;
  }

  get path(): string {
    if (!this.socketPath) throw new ApprovalError('APPROVAL_NOT_STARTED', 'The approval broker is not running.');
    return this.socketPath;
  }

  async start(): Promise<string> {
    if (this.server) return this.path;

    if (process.platform === 'win32') {
      throw new ApprovalError(
        'APPROVAL_UNSUPPORTED',
        'Interactive MCP approval currently requires a POSIX Unix socket. Non-interactive mutation is denied on this platform.',
      );
    }

    this.directory = this.options.directory ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'alur-approval-')));
    this.ownsDirectory = this.options.directory === undefined;
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700).catch(() => {});

    const socketPath = path.join(this.directory, 'approval.sock');
    await fs.unlink(socketPath).catch(() => {});
    this.socketPath = socketPath;

    const server = net.createServer((socket) => this.handleConnection(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.removeListener('listening', onListening);
        reject(new ApprovalError('APPROVAL_BROKER_FAILED', `Could not start the approval broker: ${sanitizeError(error).message}`));
      };
      const onListening = (): void => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(socketPath);
    });

    // The socket must never be usable by another local account.
    await fs.chmod(socketPath, 0o600);
    return socketPath;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => {});
    }
    if (this.socketPath) {
      await fs.unlink(this.socketPath).catch(() => {});
      this.socketPath = null;
    }
    if (this.directory && this.ownsDirectory) {
      await fs.rm(this.directory, { recursive: true, force: true }).catch(() => {});
    }
    this.directory = null;
  }

  private handleConnection(socket: net.Socket): void {
    let buffer = '';
    let handled = false;
    socket.setEncoding('utf8');
    socket.setTimeout(5_000, () => socket.destroy());

    socket.on('error', () => {});
    socket.on('data', (chunk: string) => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_REQUEST_BYTES) {
        handled = true;
        void writeResponse(socket, {
          approved: false,
          source: 'broker',
          reason: 'Approval request was too large.',
        });
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      handled = true;
      socket.setTimeout(0);
      const line = buffer.slice(0, newline);
      this.enqueue(line, socket);
    });
  }

  private enqueue(line: string, socket: net.Socket): void {
    const run = this.queue.then(() => this.respond(line, socket));
    this.queue = run.catch(() => {});
  }

  private async respond(line: string, socket: net.Socket): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      await writeResponse(socket, { approved: false, source: 'broker', reason: 'Malformed approval request.' });
      return;
    }
    if (!isWireRequest(parsed)) {
      await writeResponse(socket, { approved: false, source: 'broker', reason: 'Invalid approval request.' });
      return;
    }

    const request: MutationApprovalRequest = {
      stage: parsed.stage,
      action: parsed.action,
      details: parsed.details.map((entry) => clip(entry, 500)),
    };
    const approvalRequest: ApprovalRequest = request;
    const record = this.options.logger?.beginAction(`approval:${request.stage}`);
    let decision: ApprovalDecision;
    try {
      decision = await this.options.approver.approve(approvalRequest);
    } catch (error) {
      decision = {
        approved: false,
        source: 'interactive',
        reason: `Approval failed closed: ${sanitizeError(error).message}`,
      };
    }
    if (record) {
      this.options.logger?.endAction(
        record,
        decision.approved ? 'ok' : 'skipped',
        `${decision.source}: ${clip(decision.reason, 300)}`,
      );
    }
    await writeResponse(socket, {
      approved: decision.approved,
      source: decision.source,
      reason: clip(decision.reason, 500),
    });
  }
}

function socketIsPrivate(stat: { uid: number; mode: number }): boolean {
  if (process.platform === 'win32') return true;
  if (process.getuid && stat.uid !== process.getuid()) return false;
  return (stat.mode & 0o077) === 0;
}

/**
 * Request approval over the local broker socket. Missing, insecure, or
 * non-responsive brokers fail closed; no tool argument can grant approval.
 */
export async function requestMutationApproval(
  request: MutationApprovalRequest,
  options: { socketPath?: string; timeoutMs?: number } = {},
): Promise<void> {
  const socketPath = options.socketPath ?? process.env[APPROVAL_SOCKET_ENV];
  if (!socketPath) {
    throw new ApprovalError(
      'APPROVAL_UNAVAILABLE',
      'No local approval broker is available. Start the CLI or provide an owner-only approval socket; direct mutation is denied.',
    );
  }
  if (process.platform === 'win32') {
    throw new ApprovalError(
      'APPROVAL_UNSUPPORTED',
      'Interactive MCP approval currently requires a POSIX Unix socket. Mutation is denied on this platform.',
    );
  }

  const stat = await fs.stat(socketPath).catch((error: unknown) => {
    throw new ApprovalError(
      'APPROVAL_UNAVAILABLE',
      `The approval broker socket is not available: ${sanitizeError(error).message}`,
    );
  });
  if (!stat.isSocket() || !socketIsPrivate(stat)) {
    throw new ApprovalError(
      'APPROVAL_INSECURE',
      'The approval broker socket is not an owner-only Unix socket. Mutation is denied.',
    );
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let buffer = '';
    const socket = net.createConnection({ path: socketPath });
    const timer = setTimeout(() => {
      finish(new ApprovalError('APPROVAL_TIMEOUT', 'Timed out waiting for local approval. Mutation was denied.'));
    }, timeoutMs);
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };

    socket.setEncoding('utf8');
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
      finish(new ApprovalError('APPROVAL_TIMEOUT', 'Timed out connecting to the local approval broker.'));
    });
    socket.on('connect', () => {
      socket.setTimeout(0);
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_RESPONSE_BYTES) {
        finish(new ApprovalError('APPROVAL_PROTOCOL', 'The approval broker response was too large.'));
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(buffer.slice(0, newline));
      } catch {
        finish(new ApprovalError('APPROVAL_PROTOCOL', 'The approval broker returned malformed JSON.'));
        return;
      }
      const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
      if (record?.approved === true) {
        finish();
        return;
      }
      const reason = typeof record?.reason === 'string' ? clip(record.reason, 500) : 'Approval was not granted.';
      finish(new ApprovalError('APPROVAL_DENIED', `Approval denied: ${reason}`));
    });
    socket.on('error', (error) => {
      finish(
        new ApprovalError(
          'APPROVAL_UNAVAILABLE',
          `The approval broker connection failed: ${clip(sanitizeError(error).message, 500)}`,
        ),
      );
    });
    socket.on('close', () => {
      if (!settled) {
        finish(new ApprovalError('APPROVAL_PROTOCOL', 'The approval broker closed without a decision.'));
      }
    });
  });
}
