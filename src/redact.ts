const SENSITIVE_KEY = /^(authorization|cookie|set-cookie|password|passwd|secret|api[-_]?key|openrouter[-_]?api[-_]?key|access[-_]?token|refresh[-_]?token|token|student[-_]?name|student[-_]?class|namevalue|classvalue|nameValue|classValue)$/i;

// These fields are fixed operational metadata. Exact identity replacement is
// skipped for them so a short class value cannot corrupt hashes or file paths.
const OPERATIONAL_STRING_KEY =
  /^(sha256|hash|file|absolutefile|url|runid|ts|startedat|finishedat|capturedat|mimetype|selector|id|storagekey|inputtype|exampleid|model|task|code|state|view|label|title|mime)$/i;

const STRING_SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/sk-or-v1-[A-Za-z0-9._-]+/g, '[REDACTED_OPENROUTER_KEY]'],
  [/sk-[A-Za-z0-9_-]{16,}/g, '[REDACTED_KEY]'],
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]'],
  [/((?:api[_-]?key|token|authorization|x-api-key)=)[^&\s]+/gi, '$1[REDACTED]'],
  [/((?:x-api-key|authorization)\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]'],
];

export function redactString(value: string): string {
  let out = value;
  for (const [pattern, replacement] of STRING_SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function sensitiveValueList(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort(
    (a, b) => b.length - a.length,
  );
}

/** Exact replacement for configured identity values in free-form text. */
export function redactSensitiveString(value: string, sensitiveValues: readonly string[] = []): string {
  let out = redactString(value);
  for (const sensitive of sensitiveValueList(sensitiveValues)) {
    if (out.includes(sensitive)) out = out.split(sensitive).join('[REDACTED_IDENTITY]');
  }
  return out;
}

export function clip(value: string, max = 2_000): string {
  const cleaned = redactString(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, Math.max(0, max - 1))}…`;
}

export function redactValue(
  value: unknown,
  depth = 0,
  sensitiveValues: readonly string[] = [],
  contextKey = '',
): unknown {
  if (depth > 8) return '[MAX_DEPTH]';
  if (typeof value === 'string') {
    const clipped = clip(value, 4_000);
    return OPERATIONAL_STRING_KEY.test(contextKey) ? clipped : clip(redactSensitiveString(clipped, sensitiveValues), 4_000);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (value === undefined) return undefined;
  if (value instanceof Error) return sanitizeError(value, sensitiveValues);
  if (Array.isArray(value)) {
    return value
      .slice(0, 100)
      .map((entry) => redactValue(entry, depth + 1, sensitiveValues, contextKey));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
      out[key] = SENSITIVE_KEY.test(key)
        ? '[REDACTED]'
        : redactValue(entry, depth + 1, sensitiveValues, key);
    }
    return out;
  }
  return String(value);
}

export function sanitizeError(
  error: unknown,
  sensitiveValues: readonly string[] = [],
): {
  name: string;
  message: string;
  code?: string;
  status?: number;
  stack?: string;
} {
  if (error instanceof Error) {
    const maybe = error as Error & { code?: unknown; status?: unknown };
    return {
      name: clip(redactSensitiveString(error.name || 'Error', sensitiveValues), 120),
      message: clip(redactSensitiveString(error.message || 'Unknown error', sensitiveValues), 1_500),
      ...(typeof maybe.code === 'string' ? { code: clip(maybe.code, 120) } : {}),
      ...(typeof maybe.status === 'number' ? { status: maybe.status } : {}),
      ...(error.stack ? { stack: clip(redactSensitiveString(error.stack, sensitiveValues), 2_000) } : {}),
    };
  }
  return { name: 'Error', message: clip(redactSensitiveString(String(error), sensitiveValues), 1_500) };
}

export function maskName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 2) return `${trimmed[0] ?? ''}*`;
  return `${trimmed[0]}${'*'.repeat(Math.min(6, trimmed.length - 2))}${trimmed.at(-1)}`;
}

export function safePageText(value: string, max = 500): string {
  return clip(value.replace(/\s+/g, ' '), max);
}
