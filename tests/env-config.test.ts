import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { loadProjectEnv } from '../src/env.js';

function writeEnv(dir: string, values: Record<string, string>): void {
  const lines = Object.entries(values).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(path.join(dir, '.env'), lines.join('\n') + '\n', { encoding: 'utf8' });
}

describe('loadConfig from .env', () => {
  let tmpdir: string;

  beforeEach(async () => {
    tmpdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'alur-env-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch {}
  });

  it('loads the root .env file without depending on shell env', () => {
    writeEnv(tmpdir, {
      STUDENT_NAME: 'Test Student',
      STUDENT_CLASS: '9C',
      HEADLESS: 'true',
      ALUR_PRACTICE_EXAMPLE: 'faktorial',
    });
    const config = loadConfig({ cwd: tmpdir, mode: 'inspect', loadDotenv: true });
    expect(config.studentName).toBe('Test Student');
    expect(config.studentClass).toBe('9C');
    expect(config.headless).toBe(true);
    expect(config.practiceExample).toBe('faktorial');
  });

  it('uses defaults when .env is missing', () => {
    const config = loadConfig({ cwd: tmpdir, mode: 'inspect', loadDotenv: true });
    expect(config.alurUrl).toContain('ramli-labs');
  });

  it('does not let an exported empty key shadow a non-empty .env key', () => {
    const original = process.env.OPENROUTER_API_KEY;
    try {
      process.env.OPENROUTER_API_KEY = '   ';
      writeEnv(tmpdir, { OPENROUTER_API_KEY: 'sk-or-v1-test-only-placeholder', STUDENT_NAME: 'Test Student' });
      loadProjectEnv({ cwd: tmpdir });
      expect(process.env.OPENROUTER_API_KEY).toBe('sk-or-v1-test-only-placeholder');
    } finally {
      if (original === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = original;
    }
  });

  it('treats a whitespace-only .env key as unconfigured', () => {
    const original = process.env.OPENROUTER_API_KEY;
    try {
      delete process.env.OPENROUTER_API_KEY;
      writeEnv(tmpdir, { OPENROUTER_API_KEY: '   ', STUDENT_NAME: 'Test Student' });
      loadProjectEnv({ cwd: tmpdir });
      expect((process.env.OPENROUTER_API_KEY ?? '').trim()).toBe('');
    } finally {
      if (original === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = original;
    }
  });
});
