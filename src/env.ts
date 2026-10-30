import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

/** Repository root for both `src/` and `dist/` execution. */
export function projectRoot(): string {
  return path.resolve(moduleDirectory, '..');
}

/**
 * Resolve .env deterministically:
 * 1. an explicit cwd containing .env (used by tests and local overrides),
 * 2. otherwise the repository-root .env.
 */
export function resolveEnvPath(cwd: string = process.cwd()): string {
  const cwdEnv = path.resolve(cwd, '.env');
  if (fs.existsSync(cwdEnv)) return cwdEnv;
  return path.resolve(projectRoot(), '.env');
}

/**
 * Load the project .env. Existing shell environment variables win unless
 * `override` is explicitly requested. Missing files are silently ignored.
 */
export function loadProjectEnv(options: { cwd?: string; override?: boolean } = {}): void {
  const envPath = resolveEnvPath(options.cwd);
  if (!fs.existsSync(envPath)) return;
  // An exported-but-empty key must not shadow a real .env value.
  if (typeof process.env.OPENROUTER_API_KEY === 'string' && process.env.OPENROUTER_API_KEY.trim() === '') {
    delete process.env.OPENROUTER_API_KEY;
  }
  dotenv.config({ path: envPath, override: options.override === true, quiet: true });
}

/** Trim and treat whitespace-only values as unset. */
export function trimmedEnv(name: string): string {
  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : '';
}
