import fs from 'node:fs';
import path from 'node:path';
import {
  ensurePrivateDirectorySync,
  openPrivateAppendFileSync,
  tightenExistingFilesSync,
} from './private-fs.js';
import { clip, redactSensitiveString, redactValue, sanitizeError } from './redact.js';
import type { ActionRecord } from './types.js';

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

interface LogRecord {
  ts: string;
  runId: string;
  mode: string;
  level: LogLevel;
  event: string;
  message: string;
  data?: unknown;
}

export interface ToolLogSink {
  tool(name: string, status: 'ok' | 'error' | 'timeout', durationMs: number, errorMessage?: string): void;
  server(level: LogLevel, message: string, data?: unknown): void;
}

function localDate(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export class Logger implements ToolLogSink {
  readonly runId: string;
  readonly mode: string;
  private readonly filePath: string;
  private readonly terminal: boolean;
  private readonly sensitiveValues: readonly string[];
  private readonly actions: ActionRecord[] = [];
  private readonly warnings: string[] = [];
  private fd: number | null = null;
  private writeFailed = false;
  private closed = false;

  constructor(options: {
    dir: string;
    runId: string;
    mode: string;
    terminal?: boolean;
    sensitiveValues?: readonly string[];
  }) {
    this.runId = options.runId;
    this.mode = options.mode;
    this.terminal = options.terminal ?? true;
    this.sensitiveValues = options.sensitiveValues ?? [];
    ensurePrivateDirectorySync(options.dir);
    tightenExistingFilesSync(options.dir, /^alur-\d{4}-\d{2}-\d{2}\.jsonl$/);
    this.filePath = path.join(options.dir, `alur-${localDate()}.jsonl`);
    this.fd = openPrivateAppendFileSync(this.filePath);
  }

  get logFile(): string {
    return this.filePath;
  }

  info(message: string, data?: unknown): void {
    this.log('info', 'status', message, data);
  }

  warn(message: string, data?: unknown): void {
    this.warnings.push(clip(redactSensitiveString(message, this.sensitiveValues), 500));
    this.log('warn', 'warning', message, data);
  }

  error(message: string, error?: unknown, data?: unknown): void {
    this.log('error', 'error', message, {
      ...(data && typeof data === 'object' ? (data as Record<string, unknown>) : {}),
      ...(error === undefined ? {} : { error: sanitizeError(error, this.sensitiveValues) }),
    });
  }

  debug(message: string, data?: unknown): void {
    this.log('debug', 'debug', message, data);
  }

  server(level: LogLevel, message: string, data?: unknown): void {
    this.log(level, 'mcp-server', message, data);
  }

  tool(name: string, status: 'ok' | 'error' | 'timeout', durationMs: number, errorMessage?: string): void {
    const detail = errorMessage
      ? clip(redactSensitiveString(errorMessage, this.sensitiveValues), 500)
      : undefined;
    const record: ActionRecord = {
      state: `MCP:${name}`,
      status: status === 'ok' ? 'ok' : 'error',
      startedAt: new Date(Date.now() - durationMs).toISOString(),
      endedAt: new Date().toISOString(),
      durationMs,
      ...(detail ? { detail } : {}),
    };
    this.actions.push(record);
    this.log(status === 'ok' ? 'info' : 'error', 'tool', `MCP tool ${name}: ${status}`, {
      tool: name,
      status,
      durationMs,
      ...(detail ? { error: detail } : {}),
    });
  }

  action(state: string, status: ActionRecord['status'], detail?: string): ActionRecord {
    const record: ActionRecord = {
      state,
      status,
      startedAt: new Date().toISOString(),
      ...(detail ? { detail: clip(redactSensitiveString(detail, this.sensitiveValues), 500) } : {}),
    };
    this.actions.push(record);
    this.log(status === 'ok' ? 'info' : status === 'error' ? 'error' : 'debug', 'action', `${state}: ${status}`, record);
    return record;
  }

  beginAction(state: string): ActionRecord {
    const record: ActionRecord = { state, status: 'pending', startedAt: new Date().toISOString() };
    this.actions.push(record);
    this.log('debug', 'action', `${state}: started`, { state });
    return record;
  }

  endAction(record: ActionRecord, status: 'ok' | 'error' | 'skipped', detail?: string): void {
    record.status = status;
    record.endedAt = new Date().toISOString();
    record.durationMs = Date.parse(record.endedAt) - Date.parse(record.startedAt);
    if (detail) record.detail = clip(redactSensitiveString(detail, this.sensitiveValues), 500);
    this.log(status === 'ok' ? 'info' : status === 'error' ? 'error' : 'debug', 'action', `${record.state}: ${status}`, {
      state: record.state,
      status,
      durationMs: record.durationMs,
      ...(record.detail ? { detail: record.detail } : {}),
    });
  }

  getActions(): ActionRecord[] {
    return this.actions.map((entry) => ({ ...entry }));
  }

  getWarnings(): string[] {
    return [...this.warnings];
  }

  close(): void {
    this.closed = true;
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // The log may already have been closed by a fatal path.
      }
      this.fd = null;
    }
  }

  private log(level: LogLevel, event: string, message: string, data?: unknown): void {
    const safeMessage = clip(redactSensitiveString(message, this.sensitiveValues), 1_500);
    const record: LogRecord = {
      ts: new Date().toISOString(),
      runId: this.runId,
      mode: this.mode,
      level,
      event,
      message: safeMessage,
      ...(data === undefined ? {} : { data: redactValue(data, 0, this.sensitiveValues) }),
    };

    if (this.terminal) {
      const label = level.toUpperCase();
      const stream = level === 'error' || level === 'warn' ? console.error : console.log;
      stream(`[${label}] ${clip(safeMessage, 1_000)}`);
    }

    if (this.closed || this.writeFailed || this.fd === null) return;
    try {
      fs.writeSync(this.fd, `${JSON.stringify(record)}\n`);
    } catch (error) {
      this.writeFailed = true;
      console.error(`[WARN] Could not write log file: ${sanitizeError(error, this.sensitiveValues).message}`);
    }
  }
}
