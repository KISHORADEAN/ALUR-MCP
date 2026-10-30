#!/usr/bin/env node
import crypto from 'node:crypto';
import { loadProjectEnv } from './env.js';
import { OpenRouterAgent } from './agent.js';
import { ApprovalBroker } from './approval-broker.js';
import { ApprovalGate } from './approvals.js';
import { configSummary, ConfigError, loadConfig, type AgentConfig, type CliMode } from './config.js';
import { Logger } from './logger.js';
import { AlurMcpClient } from './mcp-client.js';
import { sanitizeError, redactSensitiveString } from './redact.js';
import { EvidenceStore } from './screenshot.js';
import { runDryRunWorkflow, runInspectWorkflow, runStartWorkflow, type DryRunResult } from './workflow.js';
import type { PageInspection } from './types.js';

interface CliOptions {
  mode: CliMode;
  yes: boolean;
  noAi: boolean;
  headless: boolean | null;
  example: string | null;
  json: boolean;
  help: boolean;
}

const HELP = `ALUR Agent — local-first Firefox assistant for the official ALUR lab

Usage:
  npm run start -- [options]       Fill configured identity, then run one approved built-in practice example
  npm run dry-run -- [options]     Read-only preflight; no identity fill and no run
  npm run inspect -- [options]     Open ALUR and print a sanitized page inspection

Options:
  -y, --yes             Explicitly pre-approve the two mutating approval gates
      --no-ai           Skip OpenRouter entirely (deterministic degraded mode)
      --headless        Run Firefox without a visible window
      --headed          Run Firefox with a visible window
      --example <id>    Built-in example: faktorial (default) or rata
      --json            Machine-readable output for inspect
  -h, --help            Show this help

Safety:
  The agent never attempts graded missions, quizzes, trace tables, or submissions.
  Without --yes, mutating steps require an interactive typed approval.
  Completion is only VERIFIED from bound page evidence; AI cannot verify it.
`;

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    mode: 'start',
    yes: false,
    noAi: false,
    headless: null,
    example: null,
    json: false,
    help: false,
  };
  const args = [...argv];
  if (args[0] && !args[0].startsWith('-')) {
    const mode = args.shift()!;
    if (mode !== 'start' && mode !== 'inspect' && mode !== 'dry-run') {
      throw new Error(`Unknown command "${mode}". Expected start, inspect, or dry-run.`);
    }
    options.mode = mode;
  }

  while (args.length > 0) {
    const arg = args.shift()!;
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--no-ai') options.noAi = true;
    else if (arg === '--headless') options.headless = true;
    else if (arg === '--headed') options.headless = false;
    else if (arg === '--json') options.json = true;
    else if (arg === '--example') {
      const value = args.shift();
      if (!value || value.startsWith('-')) throw new Error('--example requires an id: faktorial or rata.');
      options.example = value;
    } else if (arg.startsWith('--example=')) {
      options.example = arg.slice('--example='.length);
    } else {
      throw new Error(`Unknown option "${arg}". Use --help for usage.`);
    }
  }
  return options;
}

function runId(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `alur-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

function printInspection(inspection: PageInspection): void {
  const identity = inspection.identity;
  const lines = [
    'ALUR page inspection (sanitized)',
    `URL: ${inspection.url}`,
    `Title: ${inspection.title}`,
    `View: ${inspection.view}`,
    `Bootstrapped: ${inspection.bootstrapped ? 'yes' : 'no'}`,
    `Tabs: ${inspection.navTabs.map((tab) => `${tab.view}${tab.selected ? '*' : ''}`).join(', ')}`,
    `Lab status: ${inspection.lab.status.state} — ${inspection.lab.status.text}`,
    `Lab console entries: ${inspection.lab.consoleEntryCount}`,
    `Lab errorbar visible: ${inspection.lab.error.visible ? 'yes' : 'no'}`,
    `Practice examples: ${inspection.lab.examples.map((entry) => entry.id).join(', ') || 'none'}`,
    `Mission active: ${inspection.mission.active ? 'yes' : 'no'}`,
    `Mission progress: ${inspection.mission.countText || 'unknown'}`,
    `Identity fields: ${identity.fields.map((field) => `${field.label} (${field.key}, ${field.valueLength} chars)`).join(', ') || 'none'}`,
    `Identity stored: name=${identity.nameStored ? 'yes' : 'no'}, class=${identity.classStored ? 'yes' : 'no'}`,
    `Page errors: ${inspection.pageErrors.length}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

function printDryRun(result: DryRunResult): void {
  process.stdout.write('\nDry-run preflight (read-only; no form fill, no run, no screenshot)\n');
  for (const check of result.checks) {
    process.stdout.write(`  ${check.ok ? 'PASS' : 'FAIL'}  ${check.name}: ${check.detail}\n`);
  }
  process.stdout.write(`\nDry run ${result.ready ? 'READY' : 'BLOCKED'}.\n`);
}

function printStartResult(
  result: Awaited<ReturnType<typeof runStartWorkflow>>,
  sensitiveValues: readonly string[],
): void {
  process.stdout.write('\nALUR Agent result\n');
  process.stdout.write(`  Final state: ${result.finalState}\n`);
  for (const reason of result.completion.reasons) {
    process.stdout.write(`  Reason: ${redactSensitiveString(reason, sensitiveValues)}\n`);
  }
  if (result.failureReason) {
    process.stdout.write(`  Failure: ${redactSensitiveString(result.failureReason, sensitiveValues)}\n`);
  }
  process.stdout.write(`  AI: ${result.report.ai.status} (${result.report.ai.model})\n`);
  if (result.screenshot) process.stdout.write(`  Screenshot: ${result.screenshot.file}\n`);
  if (result.reportFile) process.stdout.write(`  Report: ${result.reportFile}\n`);
  process.stdout.write(`  Run ID: ${result.report.runId}\n`);
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${sanitizeError(error).message}\n`);
    process.exitCode = 3;
    return;
  }

  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  loadProjectEnv();
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (options.headless !== null) env.HEADLESS = String(options.headless);
  if (options.example !== null) env.ALUR_PRACTICE_EXAMPLE = options.example;

  const requireAi = options.mode === 'start' && !options.noAi;
  const requireIdentity = options.mode === 'start' || options.mode === 'dry-run';
  let config: AgentConfig;
  try {
    config = loadConfig({
      mode: options.mode,
      env,
      cwd: process.cwd(),
      loadDotenv: false,
      requireAi,
      requireIdentity,
    });
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.stderr.write('\nCopy .env.example to .env, fill in the local values, then retry.\n');
      process.exitCode = 3;
      return;
    }
    throw error;
  }

  // Keep stdout machine-readable for `inspect --json`; logs still go to file.
  const sensitiveValues = [config.studentName, config.studentClass, config.openRouterApiKey].filter(
    (value) => value.length > 0,
  );
  const logger = new Logger({
    dir: config.logDir,
    runId: runId(),
    mode: config.mode,
    terminal: !(config.mode === 'inspect' && options.json),
    sensitiveValues,
  });
  logger.info('Starting ALUR Agent', configSummary(config));

  let client: AlurMcpClient | null = null;
  let broker: ApprovalBroker | null = null;
  let agent: OpenRouterAgent | undefined;
  if (config.mode === 'start' && !options.noAi) {
    agent = new OpenRouterAgent({
      apiKey: config.openRouterApiKey,
      model: config.openRouterModel,
      timeoutMs: config.openRouterTimeoutMs,
      maxSteps: config.maxAgentSteps,
      sensitiveValues,
    });
  }

  try {
    if (config.mode === 'start') {
      broker = new ApprovalBroker({
        approver: new ApprovalGate({ autoApprove: options.yes }),
        logger,
      });
      await broker.start();
    }
    client = new AlurMcpClient({
      cwd: config.cwd,
      logger,
      ...(broker ? { approvalSocketPath: broker.path } : {}),
    });
    await client.start();

    if (config.mode === 'inspect') {
      const inspection = await runInspectWorkflow({ config, port: client, logger });
      if (options.json) process.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`);
      else printInspection(inspection);
      process.exitCode = 0;
      return;
    }

    if (config.mode === 'dry-run') {
      const result = await runDryRunWorkflow({ config, port: client, logger });
      printDryRun(result);
      process.exitCode = result.ready ? 0 : 2;
      return;
    }

    const result = await runStartWorkflow({
      config,
      port: client,
      logger,
      evidenceStore: new EvidenceStore({
        directory: config.evidenceDir,
        cwd: config.cwd,
        sensitiveValues,
      }),
      ...(agent ? { advisor: agent } : {}),
    });
    printStartResult(result, sensitiveValues);
    process.exitCode = result.exitCode;
  } catch (error) {
    const details = sanitizeError(error, sensitiveValues);
    logger.error('ALUR Agent stopped', error);
    process.stderr.write(`\nERROR: ${details.message}\n`);
    process.stderr.write(`Log: ${logger.logFile}\n`);
    process.exitCode = 3;
  } finally {
    await client?.close().catch(() => {});
    await broker?.close().catch(() => {});
    logger.close();
  }
}

await main().catch((error: unknown) => {
  const details = sanitizeError(error);
  process.stderr.write(`FATAL: ${details.message}\n`);
  process.exitCode = 3;
});
