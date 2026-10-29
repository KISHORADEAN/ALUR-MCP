import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  PRIVATE_FILE_MODE,
  ensurePrivateDirectory,
  isErrno,
  tightenExistingFiles,
  writeExclusivePrivateFile,
} from './private-fs.js';
import { redactValue, sanitizeError } from './redact.js';
import type { CompletionState, EvidenceReport } from './types.js';

export interface ScreenshotCapture {
  buffer: Buffer;
  fullPage: boolean;
  fallbackReason: string | null;
  width: number | null;
  height: number | null;
}

export interface StoredScreenshot {
  taskNumber: number;
  file: string;
  absoluteFile: string;
  capturedAt: string;
  bytes: number;
  sha256: string;
  width: number | null;
  height: number | null;
  fullPage: boolean;
  fallbackReason: string | null;
}

interface ScreenshotContext {
  runId: string;
  url: string;
  exampleId: string;
  exampleTitle: string;
  completionState: CompletionState;
  diagnostic?: boolean;
  capturedAt?: string;
}

export interface StoredReport {
  file: string;
  absoluteFile: string;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TASK_FILE = /^task-(\d{3})(?:\.png|\.json|\.report\.json)$/;
const DAY_FILE = /^task-\d{3}(?:\.png|\.json|\.report\.json)$/;

function localDate(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function pngDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function relativeOrAbsolute(cwd: string, absolute: string): string {
  const relative = path.relative(cwd, absolute);
  return relative.startsWith('..') || path.isAbsolute(relative) ? absolute : relative.split(path.sep).join('/');
}

function assertPrivateFileMode(mode: number, target: string): void {
  if (process.platform === 'win32') return;
  const actual = mode & 0o777;
  if (actual !== PRIVATE_FILE_MODE) {
    throw new Error(
      `Evidence integrity check failed: ${target} has mode ${actual.toString(8)}, expected ${PRIVATE_FILE_MODE.toString(8)}.`,
    );
  }
}

function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Writes screenshot evidence and its JSON sidecar. The sidecar never contains
 * the student's name, class, or an API key. Screenshots are captured in the
 * Lab view after identity fields are hidden.
 */
export class EvidenceStore {
  private readonly directory: string;
  private readonly cwd: string;
  private readonly sensitiveValues: readonly string[];

  constructor(options: {
    directory: string;
    cwd?: string;
    sensitiveValues?: readonly string[];
  }) {
    this.directory = options.directory;
    this.cwd = options.cwd ?? process.cwd();
    this.sensitiveValues = options.sensitiveValues ?? [];
  }

  private async prepareDayDirectory(capturedAt: string): Promise<string> {
    // Both the evidence root and the day directory contain private material.
    await ensurePrivateDirectory(this.directory);
    const dayDirectory = path.join(this.directory, localDate(new Date(capturedAt)));
    await ensurePrivateDirectory(dayDirectory);
    // Repair modes on pre-existing evidence without touching its contents.
    await tightenExistingFiles(dayDirectory, DAY_FILE);
    return dayDirectory;
  }

  private async verifiedPng(
    absolutePng: string,
    expected: { bytes: number; sha256: string; width: number; height: number },
  ): Promise<{ bytes: number; sha256: string; width: number; height: number }> {
    const stat = await fs.stat(absolutePng);
    if (!stat.isFile()) throw new Error('Evidence integrity check failed: the screenshot is not a regular file.');
    assertPrivateFileMode(stat.mode, absolutePng);
    const saved = await fs.readFile(absolutePng);
    if (saved.length !== expected.bytes) {
      throw new Error(
        `Evidence integrity check failed: saved screenshot has ${saved.length} bytes, expected ${expected.bytes}.`,
      );
    }
    const savedSha = sha256(saved);
    if (savedSha !== expected.sha256) {
      throw new Error('Evidence integrity check failed: saved screenshot SHA-256 does not match the capture.');
    }
    const dimensions = pngDimensions(saved);
    if (!dimensions) throw new Error('Evidence integrity check failed: saved screenshot is not a valid PNG.');
    if (dimensions.width !== expected.width || dimensions.height !== expected.height) {
      throw new Error(
        `Evidence integrity check failed: saved screenshot is ${dimensions.width}x${dimensions.height}, expected ${expected.width}x${expected.height}.`,
      );
    }
    return { bytes: saved.length, sha256: savedSha, ...dimensions };
  }

  private async verifySidecar(absoluteJson: string, expected: { task: string; sha256: string }): Promise<void> {
    const stat = await fs.stat(absoluteJson);
    if (!stat.isFile()) throw new Error('Evidence integrity check failed: the sidecar is not a regular file.');
    assertPrivateFileMode(stat.mode, absoluteJson);
    const parsed = JSON.parse(await fs.readFile(absoluteJson, 'utf8')) as {
      task?: unknown;
      image?: { sha256?: unknown };
    };
    if (parsed.task !== expected.task || parsed.image?.sha256 !== expected.sha256) {
      throw new Error('Evidence integrity check failed: the sidecar does not match the saved screenshot.');
    }
  }

  async saveScreenshot(capture: ScreenshotCapture, context: ScreenshotContext): Promise<StoredScreenshot> {
    const dimensions = pngDimensions(capture.buffer);
    if (!dimensions) throw new Error('Refusing to store evidence: the screenshot is not a valid PNG.');
    if (capture.buffer.length === 0) throw new Error('Refusing to store an empty screenshot.');
    if (capture.width !== null && capture.width !== dimensions.width) {
      throw new Error('Refusing to store evidence: reported screenshot width does not match the PNG.');
    }
    if (capture.height !== null && capture.height !== dimensions.height) {
      throw new Error('Refusing to store evidence: reported screenshot height does not match the PNG.');
    }

    const capturedAt = context.capturedAt ?? new Date().toISOString();
    const dayDirectory = await this.prepareDayDirectory(capturedAt);

    const existing = await fs.readdir(dayDirectory);
    let next = 1;
    for (const name of existing) {
      const match = TASK_FILE.exec(name);
      if (match) next = Math.max(next, Number(match[1]) + 1);
    }

    const digest = sha256(capture.buffer);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const taskNumber = next + attempt;
      const base = `task-${String(taskNumber).padStart(3, '0')}`;
      const absolutePng = path.join(dayDirectory, `${base}.png`);
      const absoluteJson = path.join(dayDirectory, `${base}.json`);
      const file = relativeOrAbsolute(this.cwd, absolutePng);
      const sidecar = {
        schemaVersion: 1,
        kind: 'screenshot-evidence',
        task: base,
        capturedAt,
        runId: context.runId,
        diagnostic: context.diagnostic === true,
        url: context.url,
        completionState: context.completionState,
        practice: {
          exampleId: context.exampleId,
          title: context.exampleTitle,
        },
        image: {
          file,
          mimeType: 'image/png',
          bytes: capture.buffer.length,
          sha256: digest,
          width: dimensions.width,
          height: dimensions.height,
          fullPage: capture.fullPage,
          fallbackReason: capture.fallbackReason,
        },
      };
      const safeSidecar = redactValue(sidecar, 0, this.sensitiveValues);

      try {
        await writeExclusivePrivateFile(absolutePng, capture.buffer);
      } catch (error) {
        if (isErrno(error, 'EEXIST')) continue;
        throw error;
      }

      let verified: { bytes: number; sha256: string; width: number; height: number };
      let sidecarWritten = false;
      try {
        verified = await this.verifiedPng(absolutePng, {
          bytes: capture.buffer.length,
          sha256: digest,
          width: dimensions.width,
          height: dimensions.height,
        });
        await writeExclusivePrivateFile(absoluteJson, `${JSON.stringify(safeSidecar, null, 2)}\n`);
        sidecarWritten = true;
        await this.verifySidecar(absoluteJson, { task: base, sha256: verified.sha256 });
      } catch (error) {
        // A PNG or sidecar that already belongs to another writer must never
        // be deleted. Only remove files created by this attempt.
        await fs.unlink(absolutePng).catch(() => {});
        if (isErrno(error, 'EEXIST')) continue;
        if (sidecarWritten) await fs.unlink(absoluteJson).catch(() => {});
        throw error;
      }

      return {
        taskNumber,
        file,
        absoluteFile: absolutePng,
        capturedAt,
        bytes: verified.bytes,
        sha256: verified.sha256,
        width: verified.width,
        height: verified.height,
        fullPage: capture.fullPage,
        fallbackReason: capture.fallbackReason,
      };
    }

    throw new Error('Could not allocate a unique evidence filename after 100 attempts.');
  }

  async saveReport(report: EvidenceReport, taskNumber: number, capturedAt?: string): Promise<StoredReport> {
    if (!Number.isInteger(taskNumber) || taskNumber < 1) {
      throw new Error('A valid evidence task number is required to save the report.');
    }
    // Use the screenshot's capture date when supplied so a run that crosses
    // midnight keeps its report beside the same task-numbered PNG.
    const dayDirectory = await this.prepareDayDirectory(capturedAt ?? report.startedAt);
    const base = `task-${String(taskNumber).padStart(3, '0')}`;
    return this.writeReport(report, dayDirectory, base);
  }

  /** Saves a report for an aborted/failed run that has no screenshot evidence. */
  async saveReportOnly(report: EvidenceReport): Promise<StoredReport> {
    const dayDirectory = await this.prepareDayDirectory(report.startedAt);
    const existing = await fs.readdir(dayDirectory);
    let next = 1;
    for (const name of existing) {
      const match = TASK_FILE.exec(name);
      if (match) next = Math.max(next, Number(match[1]) + 1);
    }
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const base = `task-${String(next + attempt).padStart(3, '0')}`;
      try {
        return await this.writeReport(report, dayDirectory, base);
      } catch (error) {
        if (isErrno(error, 'EEXIST')) continue;
        throw error;
      }
    }
    throw new Error('Could not allocate a unique report filename after 100 attempts.');
  }

  private async writeReport(report: EvidenceReport, dayDirectory: string, base: string): Promise<StoredReport> {
    const absoluteJson = path.join(dayDirectory, `${base}.report.json`);
    const safeReport = redactValue(report, 0, this.sensitiveValues) as EvidenceReport;
    try {
      await writeExclusivePrivateFile(absoluteJson, `${JSON.stringify(safeReport, null, 2)}\n`);
      const stat = await fs.stat(absoluteJson);
      assertPrivateFileMode(stat.mode, absoluteJson);
      JSON.parse(await fs.readFile(absoluteJson, 'utf8'));
    } catch (error) {
      // Never delete a report that another writer may have created.
      if (isErrno(error, 'EEXIST')) throw error;
      await fs.unlink(absoluteJson).catch(() => {});
      throw new Error(`Could not save the sanitized report (${base}): ${sanitizeError(error).message}`);
    }

    return {
      file: relativeOrAbsolute(this.cwd, absoluteJson),
      absoluteFile: absoluteJson,
    };
  }
}
