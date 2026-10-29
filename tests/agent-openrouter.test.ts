import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentError, OpenRouterAgent, type AgentCapabilities } from '../src/agent.js';

const SYNTHETIC_KEY = 'sk-or-v1-synthetic-test-key-1234567890';

function createMockFetch(responses: Map<string, { status: number; body: unknown; delay?: number }>): typeof fetch {
  return vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    const key = typeof url === 'string' ? url : url.toString();
    const match = responses.get(key);
    if (!match) {
      const urlObj = typeof url === 'string' ? new URL(url) : url instanceof URL ? url : new URL(url.toString());
      const pathKey = urlObj.pathname;
      const pathMatch = responses.get(pathKey);
      if (pathMatch) {
        return createResponse(pathMatch);
      }
      throw new Error(`No mock response for ${key}`);
    }
    return createResponse(match);
    
    async function createResponse(match: { status: number; body: unknown; delay?: number }) {
      if (match.delay) {
        await new Promise((resolve) => setTimeout(resolve, match.delay));
      }
      if (options?.signal?.aborted) {
        const error = new Error('Aborted');
        error.name = 'AbortError';
        throw error;
      }
      const response = {
        ok: match.status >= 200 && match.status < 300,
        status: match.status,
        statusText: match.status >= 400 ? 'Error' : 'OK',
        json: async () => match.body,
        text: async () => JSON.stringify(match.body),
      } as Response;
      return response;
    }
  });
}

describe('OpenRouterAgent error handling', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('handles HTTP 401 on chat completion as security-relevant (no retry)', async () => {
    global.fetch = createMockFetch(
      new Map([
        [
          'https://openrouter.ai/api/v1/models',
          {
            status: 200,
            body: { data: [{ id: 'openrouter/free', supported_parameters: ['tools'], context_length: 4096 }] },
          },
        ],
        [
          'https://openrouter.ai/api/v1/chat/completions',
          { status: 401, body: { error: { message: 'Invalid key', type: 'authentication_error' } } },
        ],
      ]),
    );

    const agent = new OpenRouterAgent({
      apiKey: SYNTHETIC_KEY,
      model: 'openrouter/free',
      timeoutMs: 10_000,
      maxSteps: 5,
    });

    try {
      const assessment = await agent.review({
        stage: 'preflight',
        inspection: {
          url: 'https://ramli-labs.github.io/ALUR/',
          title: 'ALUR',
          view: 'lab',
          bootstrapped: true,
          navTabs: [],
          identity: { fields: [], nameStored: false, classStored: false, bothVisible: false, problems: [] },
          lab: {
            status: { state: 'ready', text: 'Siap' },
            consoleOutput: [],
            consoleEntryCount: 0,
            error: { visible: false, text: '' },
            editor: { present: true, length: 100, knownPracticeSignatures: [] },
            inputsLength: 0,
            examples: [{ id: 'faktorial', title: 'Faktorial n' }],
          },
          mission: { active: false, countText: '0/12', selected: null, summary: null, cards: [] },
          pageErrors: [],
        },
        allowedActions: ['fill_identity', 'run_practice', 'capture_evidence', 'stop'],
      });
      console.log('Assessment:', JSON.stringify(assessment, null, 2));
      expect(assessment.status).toBe('failed');
      expect(assessment.error).toContain('HTTP 401');
    } catch (e) {
      console.error('Error thrown:', e);
      throw e;
    }
  });
});