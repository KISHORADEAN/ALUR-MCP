import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain JS helper without type declarations
import { checkChat, checkModels, configuredKey } from '../scripts/openrouter-smoke-lib.js';

const SECRET = 'sk-or-v1-test-secret-do-not-print';

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 400 ? 'Error' : 'OK',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function failingFetch(error: Error) {
  return async () => {
    throw error;
  };
}

describe('configuredKey', () => {
  it('treats missing, empty, and whitespace-only keys as unconfigured', () => {
    expect(configuredKey(undefined)).toBe('');
    expect(configuredKey('')).toBe('');
    expect(configuredKey('   ')).toBe('');
    expect(configuredKey('\t\n')).toBe('');
  });

  it('trims a configured key without exposing it', () => {
    expect(configuredKey(`  ${SECRET}  `)).toBe(SECRET);
  });
});

describe('checkModels', () => {
  it('returns UNVERIFIED when no key is configured and makes no request', async () => {
    let called = false;
    const result = await checkModels({
      apiKey: '   ',
      fetchImpl: async () => {
        called = true;
        return response(200, { data: [] });
      },
    });
    expect(result.status).toBe('UNVERIFIED');
    expect(called).toBe(false);
  });

  it('returns PASS for HTTP 200 with a non-empty models array', async () => {
    const result = await checkModels({
      apiKey: SECRET,
      fetchImpl: async () => response(200, { data: [{ id: 'openrouter/free' }] }),
    });
    expect(result.status).toBe('PASS');
    expect(result.models).toBe(1);
  });

  it('returns FAIL for HTTP 401 without leaking the key', async () => {
    const result = await checkModels({ apiKey: SECRET, fetchImpl: async () => response(401, { error: 'bad key' }) });
    expect(result.status).toBe('FAIL');
    expect(result.reason).toContain('401');
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('returns FAIL for invalid response bodies', async () => {
    const result = await checkModels({ apiKey: SECRET, fetchImpl: async () => response(200, { notData: [] }) });
    expect(result.status).toBe('FAIL');
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('returns FAIL for HTTP 5xx', async () => {
    const result = await checkModels({ apiKey: SECRET, fetchImpl: async () => response(503, { error: 'down' }) });
    expect(result.status).toBe('FAIL');
    expect(result.reason).toContain('503');
  });

  it('handles timeouts safely', async () => {
    const error = new Error('The operation was aborted due to timeout');
    error.name = 'TimeoutError';
    const result = await checkModels({ apiKey: SECRET, fetchImpl: failingFetch(error) });
    expect(result.status).toBe('FAIL');
    expect(result.reason).toMatch(/timed out/i);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('handles network failures safely', async () => {
    const result = await checkModels({ apiKey: SECRET, fetchImpl: failingFetch(new Error(`network failed with ${SECRET}`)) });
    expect(result.status).toBe('FAIL');
    expect(result.reason).toMatch(/network/i);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

describe('checkChat', () => {
  it('returns UNVERIFIED when no key is configured and makes no request', async () => {
    let called = false;
    const result = await checkChat({
      apiKey: '',
      fetchImpl: async () => {
        called = true;
        return response(200, { choices: [{ message: { content: 'OK' } }] });
      },
    });
    expect(result.status).toBe('UNVERIFIED');
    expect(called).toBe(false);
  });

  it('returns PASS for HTTP 200 with non-empty answer text', async () => {
    const result = await checkChat({
      apiKey: SECRET,
      fetchImpl: async () => response(200, { choices: [{ message: { content: 'OK' } }] }),
    });
    expect(result.status).toBe('PASS');
    expect(result.characters).toBe(2);
  });

  it('returns FAIL for HTTP 200 with empty answer text', async () => {
    const result = await checkChat({
      apiKey: SECRET,
      fetchImpl: async () => response(200, { choices: [{ message: { content: '   ' } }] }),
    });
    expect(result.status).toBe('FAIL');
    expect(result.reason).toMatch(/no non-empty answer/i);
  });

  it('returns FAIL for HTTP 200 with missing choices', async () => {
    const result = await checkChat({ apiKey: SECRET, fetchImpl: async () => response(200, {}) });
    expect(result.status).toBe('FAIL');
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('returns FAIL for HTTP 401, 402, 429, and 500 without leaking the key', async () => {
    for (const status of [401, 402, 429, 500]) {
      const result = await checkChat({ apiKey: SECRET, fetchImpl: async () => response(status, { error: 'nope' }) });
      expect(result.status).toBe('FAIL');
      expect(result.reason).toContain(String(status));
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }
  });

  it('handles timeouts safely', async () => {
    const error = new Error('aborted');
    error.name = 'TimeoutError';
    const result = await checkChat({ apiKey: SECRET, fetchImpl: failingFetch(error) });
    expect(result.status).toBe('FAIL');
    expect(result.reason).toMatch(/timed out/i);
  });

  it('handles network failures safely', async () => {
    const result = await checkChat({ apiKey: SECRET, fetchImpl: failingFetch(new Error(`network failed with ${SECRET}`)) });
    expect(result.status).toBe('FAIL');
    expect(result.reason).toMatch(/network/i);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});
