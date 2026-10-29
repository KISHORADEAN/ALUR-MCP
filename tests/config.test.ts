import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, configSummary, loadConfig } from '../src/config.js';
import { DEFAULT_ALUR_URL } from '../src/site.js';

const CWD = '/tmp/alur-agent-config-test';

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    OPENROUTER_API_KEY: `sk-or-v1-${'a'.repeat(40)}`,
    OPENROUTER_MODEL: 'openrouter/free',
    STUDENT_NAME: 'Test Student',
    STUDENT_CLASS: '9C',
    HEADLESS: 'true',
    ...overrides,
  };
}

function load(overrides: NodeJS.ProcessEnv = {}, options: Partial<Parameters<typeof loadConfig>[0]> = {}) {
  return loadConfig({
    env: env(overrides),
    cwd: CWD,
    loadDotenv: false,
    mode: 'start',
    ...options,
  });
}

describe('loadConfig', () => {
  it('loads a safe start configuration with defaults', () => {
    const config = load();
    expect(config.alurUrl).toBe(DEFAULT_ALUR_URL);
    expect(config.openRouterModel).toBe('openrouter/free');
    expect(config.practiceExample).toBe('faktorial');
    expect(config.headless).toBe(true);
    expect(config.maxAgentSteps).toBe(10);
    expect(config.requireAi).toBe(true);
    expect(config.requireIdentity).toBe(true);
    expect(config.evidenceDir).toBe(path.resolve(CWD, 'evidence'));
    expect(config.logDir).toBe(path.resolve(CWD, 'logs'));
  });

  it('normalizes the official index.html URL and accepts the rata example', () => {
    const config = load({
      ALUR_URL: 'https://ramli-labs.github.io/ALUR/index.html',
      ALUR_PRACTICE_EXAMPLE: 'rata',
    });
    expect(config.alurUrl).toBe(DEFAULT_ALUR_URL);
    expect(config.practiceExample).toBe('rata');
  });

  it.each([
    ['http://ramli-labs.github.io/ALUR/', 'https'],
    ['https://example.com/ALUR/', 'official origin'],
    ['https://ramli-labs.github.io/OTHER/', 'point to /ALUR/'],
    ['not-a-url', 'valid URL'],
  ])('rejects an unsafe ALUR_URL: %s', (url, message) => {
    expect(() => load({ ALUR_URL: url })).toThrow(ConfigError);
    try {
      load({ ALUR_URL: url });
    } catch (error) {
      expect((error as Error).message).toContain(message);
    }
  });

  it('requires an API key and identity for start', () => {
    expect(() => load({ OPENROUTER_API_KEY: '', STUDENT_NAME: '' })).toThrow(ConfigError);
    try {
      load({ OPENROUTER_API_KEY: '', STUDENT_NAME: '' });
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('OPENROUTER_API_KEY is required');
      expect(message).toContain('STUDENT_NAME is required');
    }
  });

  it('allows read-only inspect without identity or an API key', () => {
    const config = load(
      { OPENROUTER_API_KEY: '', STUDENT_NAME: '', STUDENT_CLASS: '' },
      { mode: 'inspect' },
    );
    expect(config.mode).toBe('inspect');
    expect(config.requireAi).toBe(false);
    expect(config.requireIdentity).toBe(false);
    expect(config.studentName).toBe('');
  });

  it('requires identity but not AI for dry-run by default', () => {
    const config = load({ OPENROUTER_API_KEY: '' }, { mode: 'dry-run' });
    expect(config.requireAi).toBe(false);
    expect(config.requireIdentity).toBe(true);
    expect(() => load({ STUDENT_NAME: '' }, { mode: 'dry-run' })).toThrow(ConfigError);
  });

  it('rejects placeholder or malformed API keys when AI is required', () => {
    expect(() => load({ OPENROUTER_API_KEY: 'your-key-here-1234567890' })).toThrow(ConfigError);
    expect(() => load({ OPENROUTER_API_KEY: 'short' })).toThrow(ConfigError);
    expect(() => load({ OPENROUTER_API_KEY: 'valid-looking key with spaces 123456' })).toThrow(ConfigError);
  });

  it('can explicitly skip AI requirements', () => {
    const config = load({ OPENROUTER_API_KEY: '' }, { requireAi: false });
    expect(config.requireAi).toBe(false);
  });

  it('rejects invalid numeric and boolean settings', () => {
    expect(() => load({ MAX_AGENT_STEPS: '0' })).toThrow(ConfigError);
    expect(() => load({ MAX_AGENT_STEPS: '31' })).toThrow(ConfigError);
    expect(() => load({ OPENROUTER_TIMEOUT_MS: '1000' })).toThrow(ConfigError);
    expect(() => load({ HEADLESS: 'maybe' })).toThrow(ConfigError);
  });

  it('rejects unknown practice examples', () => {
    expect(() => load({ ALUR_PRACTICE_EXAMPLE: 'm6' })).toThrow(ConfigError);
  });

  it('never exposes the key, name, or class in the safe summary', () => {
    const config = load();
    const summary = JSON.stringify(configSummary(config));
    expect(summary).not.toContain('sk-or-v1');
    expect(summary).not.toContain('Test Student');
    expect(summary).not.toContain('9C');
    expect(summary).toContain('"nameConfigured":true');
    expect(summary).toContain('"classConfigured":true');
  });
});
