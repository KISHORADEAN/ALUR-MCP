import path from 'node:path';
import dotenv from 'dotenv';
import { DEFAULT_ALUR_URL, isPracticeExampleId, normalizeAlurUrl, type PracticeExample } from './site.js';

export type CliMode = 'start' | 'inspect' | 'dry-run';

export interface AgentConfig {
  cwd: string;
  alurUrl: string;
  openRouterApiKey: string;
  openRouterModel: string;
  studentName: string;
  studentClass: string;
  headless: boolean;
  maxAgentSteps: number;
  openRouterTimeoutMs: number;
  practiceExample: PracticeExample['id'];
  evidenceDir: string;
  logDir: string;
  requireAi: boolean;
  requireIdentity: boolean;
  mode: CliMode;
}

export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid configuration:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  mode?: CliMode;
  requireAi?: boolean;
  requireIdentity?: boolean;
  loadDotenv?: boolean;
}

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

function parseBoolean(raw: string | undefined, name: string, defaultValue: boolean, problems: string[]): boolean {
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const value = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(value)) return true;
  if (['false', '0', 'no', 'n'].includes(value)) return false;
  problems.push(`${name} must be true or false (got "${raw}").`);
  return defaultValue;
}

function parseInteger(
  raw: string | undefined,
  name: string,
  defaultValue: number,
  min: number,
  max: number,
  problems: string[],
): number {
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    problems.push(`${name} must be an integer from ${min} to ${max} (got "${raw}").`);
    return defaultValue;
  }
  return value;
}

function parseText(
  raw: string | undefined,
  name: string,
  maxLength: number,
  problems: string[],
  required: boolean,
): string {
  const value = (raw ?? '').trim();
  if (!value) {
    if (required) problems.push(`${name} is required. Set it in .env or the environment.`);
    return '';
  }
  if (value.length > maxLength) {
    problems.push(`${name} must be at most ${maxLength} characters.`);
    return '';
  }
  if (CONTROL_CHARS.test(value)) {
    problems.push(`${name} must not contain control characters or line breaks.`);
    return '';
  }
  return value;
}

export function loadConfig(options: LoadConfigOptions = {}): AgentConfig {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const mode = options.mode ?? 'start';
  const requireAi = options.requireAi ?? mode === 'start';
  const requireIdentity = options.requireIdentity ?? (mode === 'start' || mode === 'dry-run');

  if (options.loadDotenv !== false && env === process.env) {
    dotenv.config({ path: path.join(cwd, '.env'), quiet: true });
  }

  const problems: string[] = [];

  const urlCheck = normalizeAlurUrl(env.ALUR_URL ?? DEFAULT_ALUR_URL);
  if (!urlCheck.url) problems.push(urlCheck.error ?? 'ALUR_URL is invalid.');
  const alurUrl = urlCheck.url ?? DEFAULT_ALUR_URL;

  const openRouterModel = parseText(env.OPENROUTER_MODEL ?? 'openrouter/free', 'OPENROUTER_MODEL', 200, problems, true);
  if (openRouterModel && !/^[A-Za-z0-9][A-Za-z0-9._:/~-]{0,199}$/.test(openRouterModel)) {
    problems.push(
      'OPENROUTER_MODEL contains unsupported characters. Use the exact OpenRouter model id, for example "openrouter/free".',
    );
  }

  const openRouterApiKey = parseText(
    env.OPENROUTER_API_KEY,
    'OPENROUTER_API_KEY',
    400,
    problems,
    requireAi,
  );
  if (requireAi && openRouterApiKey) {
    if (openRouterApiKey.length < 20 || /\s/.test(openRouterApiKey)) {
      problems.push('OPENROUTER_API_KEY does not look like a valid OpenRouter API key.');
    }
    if (/^(your|replace|changeme|example)/i.test(openRouterApiKey)) {
      problems.push('OPENROUTER_API_KEY still looks like a placeholder. Replace it with a real key.');
    }
  }

  const studentName = parseText(env.STUDENT_NAME, 'STUDENT_NAME', 80, problems, requireIdentity);
  const studentClass = parseText(env.STUDENT_CLASS, 'STUDENT_CLASS', 20, problems, requireIdentity);

  const headless = parseBoolean(env.HEADLESS, 'HEADLESS', false, problems);
  const maxAgentSteps = parseInteger(env.MAX_AGENT_STEPS, 'MAX_AGENT_STEPS', 10, 1, 30, problems);
  const openRouterTimeoutMs = parseInteger(
    env.OPENROUTER_TIMEOUT_MS,
    'OPENROUTER_TIMEOUT_MS',
    45_000,
    5_000,
    180_000,
    problems,
  );

  const exampleRaw = (env.ALUR_PRACTICE_EXAMPLE ?? 'faktorial').trim();
  if (!isPracticeExampleId(exampleRaw)) {
    problems.push('ALUR_PRACTICE_EXAMPLE must be one of: faktorial, rata.');
  }
  const practiceExample = isPracticeExampleId(exampleRaw) ? exampleRaw : 'faktorial';

  const evidenceDir = path.resolve(cwd, env.ALUR_EVIDENCE_DIR?.trim() || 'evidence');
  const logDir = path.resolve(cwd, env.ALUR_LOG_DIR?.trim() || 'logs');

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    cwd,
    alurUrl,
    openRouterApiKey,
    openRouterModel,
    studentName,
    studentClass,
    headless,
    maxAgentSteps,
    openRouterTimeoutMs,
    practiceExample,
    evidenceDir,
    logDir,
    requireAi,
    requireIdentity,
    mode,
  };
}

/** Safe to log or store in evidence. Never includes the key, name, or class. */
export function configSummary(config: AgentConfig): {
  alurUrl: string;
  headless: boolean;
  maxAgentSteps: number;
  practiceExample: string;
  model: string;
  nameConfigured: boolean;
  classConfigured: boolean;
  identityRequired: boolean;
  aiRequired: boolean;
} {
  return {
    alurUrl: config.alurUrl,
    headless: config.headless,
    maxAgentSteps: config.maxAgentSteps,
    practiceExample: config.practiceExample,
    model: config.openRouterModel,
    nameConfigured: config.studentName.length > 0,
    classConfigured: config.studentClass.length > 0,
    identityRequired: config.requireIdentity,
    aiRequired: config.requireAi,
  };
}
