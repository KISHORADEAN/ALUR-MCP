import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIRECTORY_MODE = 0o700;

function ignoreWindows(mode: number): void {
  if (process.platform === 'win32') return;
  if (!Number.isInteger(mode)) throw new Error('Invalid file mode.');
}

function assertPrivateMode(actual: number, expected: number, target: string): void {
  if (process.platform === 'win32') return;
  const mode = actual & 0o777;
  if (mode !== expected) {
    throw new Error(
      `Refusing to continue: ${target} has mode ${mode.toString(8)}, expected ${expected.toString(8)}.`,
    );
  }
}

export function ensurePrivateDirectorySync(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  ignoreWindows(PRIVATE_DIRECTORY_MODE);
  fs.chmodSync(directory, PRIVATE_DIRECTORY_MODE);
  assertPrivateMode(fs.statSync(directory).mode, PRIVATE_DIRECTORY_MODE, directory);
}

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fsp.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  ignoreWindows(PRIVATE_DIRECTORY_MODE);
  await fsp.chmod(directory, PRIVATE_DIRECTORY_MODE);
  assertPrivateMode((await fsp.stat(directory)).mode, PRIVATE_DIRECTORY_MODE, directory);
}

/**
 * Repairs permissions on files already in a private directory. The file
 * contents are never read or modified.
 */
export function tightenExistingFilesSync(directory: string, pattern: RegExp): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const name of entries) {
    if (!pattern.test(name)) continue;
    const file = path.join(directory, name);
    const stat = fs.statSync(file);
    if (!stat.isFile()) continue;
    fs.chmodSync(file, PRIVATE_FILE_MODE);
    assertPrivateMode(fs.statSync(file).mode, PRIVATE_FILE_MODE, file);
  }
}

export async function tightenExistingFiles(directory: string, pattern: RegExp): Promise<void> {
  let entries: string[];
  try {
    entries = await fsp.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const name of entries) {
    if (!pattern.test(name)) continue;
    const file = path.join(directory, name);
    const stat = await fsp.stat(file);
    if (!stat.isFile()) continue;
    await fsp.chmod(file, PRIVATE_FILE_MODE);
    assertPrivateMode((await fsp.stat(file)).mode, PRIVATE_FILE_MODE, file);
  }
}

/** Opens an append-only log with owner-only permissions on both create and reuse. */
export function openPrivateAppendFileSync(file: string): number {
  const fd = fs.openSync(file, 'a', PRIVATE_FILE_MODE);
  try {
    ignoreWindows(PRIVATE_FILE_MODE);
    fs.fchmodSync(fd, PRIVATE_FILE_MODE);
    assertPrivateMode(fs.fstatSync(fd).mode, PRIVATE_FILE_MODE, file);
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

/**
 * Publishes a file atomically with an owner-only mode. The temporary file is
 * written with 0600 before a hard link makes it visible, so a reader can never
 * observe a partially written or broader-permission file. The hard link also
 * preserves exclusive-create semantics.
 */
export async function writeExclusivePrivateFile(file: string, data: string | Buffer): Promise<void> {
  const directory = path.dirname(file);
  const temp = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  let handle: fsp.FileHandle | null = null;
  try {
    handle = await fsp.open(temp, 'wx', PRIVATE_FILE_MODE);
    ignoreWindows(PRIVATE_FILE_MODE);
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.link(temp, file);
    await fsp.unlink(temp).catch(() => {});
    assertPrivateMode((await fsp.stat(file)).mode, PRIVATE_FILE_MODE, file);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fsp.unlink(temp).catch(() => {});
    throw error;
  }
}

export function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}
