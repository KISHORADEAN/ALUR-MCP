#!/usr/bin/env node
/**
 * Pure, testable OpenRouter smoke-check helpers. No secrets are logged.
 * All network access is injectable for unit tests.
 */

const DEFAULT_TIMEOUT_MS = 15_000;

export function configuredKey(raw) {
  return typeof raw === 'string' ? raw.trim() : '';
}

export async function checkModels({ apiKey, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const key = configuredKey(apiKey);
  if (!key) return { status: 'UNVERIFIED', reason: 'OPENROUTER_API_KEY not configured.' };

  let response;
  try {
    response = await fetchImpl('https://openrouter.ai/api/v1/models', {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = error && typeof error === 'object' && error.name === 'TimeoutError';
    return { status: 'FAIL', reason: timedOut ? 'Request timed out.' : 'Network error.' };
  }

  if (response.status === 401 || response.status === 403) {
    return { status: 'FAIL', reason: `OpenRouter rejected the configured key (HTTP ${response.status}).` };
  }
  if (!response.ok) {
    return { status: 'FAIL', reason: `OpenRouter /models returned HTTP ${response.status}.` };
  }

  let body;
  try {
    body = await response.json();
  } catch {
    return { status: 'FAIL', reason: 'HTTP 200 but response was not valid JSON.' };
  }

  if (!body || typeof body !== 'object' || !Array.isArray(body.data) || body.data.length === 0) {
    return { status: 'FAIL', reason: 'HTTP 200 but response body did not contain a non-empty models array.' };
  }

  return { status: 'PASS', models: body.data.length };
}

export async function checkChat({ apiKey, model = 'openrouter/free', fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  const key = configuredKey(apiKey);
  if (!key) return { status: 'UNVERIFIED', reason: 'OPENROUTER_API_KEY not configured.' };

  let response;
  try {
    response = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with exactly the two characters: OK' }],
        max_tokens: 8,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = error && typeof error === 'object' && error.name === 'TimeoutError';
    return { status: 'FAIL', reason: timedOut ? 'Chat completion timed out.' : 'Network error.' };
  }

  if (response.status === 401 || response.status === 403) {
    return { status: 'FAIL', reason: `OpenRouter rejected the configured key (HTTP ${response.status}).` };
  }
  if (response.status === 402) {
    return { status: 'FAIL', reason: 'OpenRouter reported insufficient credits/payment required (HTTP 402).' };
  }
  if (response.status === 429) {
    return { status: 'FAIL', reason: 'OpenRouter rate limited the request (HTTP 429). Retry later.' };
  }
  if (!response.ok) {
    return { status: 'FAIL', reason: `OpenRouter /chat/completions returned HTTP ${response.status}.` };
  }

  let body;
  try {
    body = await response.json();
  } catch {
    return { status: 'FAIL', reason: 'HTTP 200 but response was not valid JSON.' };
  }

  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    return { status: 'FAIL', reason: 'HTTP 200 but chat completion contained no non-empty answer text.' };
  }

  return { status: 'PASS', model, characters: content.trim().length };
}
