import { configSummary, type AgentConfig } from './config.js';
import { evaluatePracticeCompletion } from './completion.js';
import type { AgentAssessment, AgentReviewContext } from './agent.js';
import type { Logger } from './logger.js';
import { clip, sanitizeError } from './redact.js';
import {
  PRACTICE_EXAMPLES,
  isAllowedAlurPage,
  type AlurView,
  type PracticeExample,
} from './site.js';
import type { EvidenceStore, ScreenshotCapture, StoredReport, StoredScreenshot } from './screenshot.js';
import type {
  CompletionResult,
  EvidenceReport,
  IdentityVerification,
  PageInspection,
  PracticeRunEvidence,
} from './types.js';

export interface AlurAutomationPort {
  launch(headless: boolean): Promise<{ browser: 'firefox'; headless: boolean }>;
  open(): Promise<{ url: string; title: string }>;
  inspect(): Promise<PageInspection>;
  openView(view: AlurView): Promise<{ view: AlurView; visible: boolean }>;
  fillIdentity(expected: { name: string; className: string }): Promise<IdentityVerification>;
  verifyIdentity(expected: { name: string; className: string }): Promise<IdentityVerification>;
  runPractice(example: PracticeExample['id']): Promise<PracticeRunEvidence>;
  screenshot(fullPage: boolean): Promise<ScreenshotCapture>;
  close(): Promise<void>;
}

export interface Advisor {
  review(context: AgentReviewContext): Promise<AgentAssessment>;
}

export class WorkflowError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'WorkflowError';
    this.code = code;
  }
}

class WorkflowAbort extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowAbort';
  }
}

export interface PreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface StartWorkflowOptions {
  config: AgentConfig;
  port: AlurAutomationPort;
  logger: Logger;
  evidenceStore: EvidenceStore;
  advisor?: Advisor;
  now?: () => Date;
}

export interface StartWorkflowResult {
  finalState: EvidenceReport['finalState'];
  completion: CompletionResult;
  report: EvidenceReport;
  reportFile: string | null;
  screenshot: StoredScreenshot | null;
  failureReason: string | null;
  aborted: boolean;
  exitCode: number;
}

export interface DryRunResult {
  ready: boolean;
  checks: PreflightCheck[];
  inspection: PageInspection;
}

export interface InspectWorkflowOptions {
  config: AgentConfig;
  port: AlurAutomationPort;
  logger: Logger;
}

export interface DryRunWorkflowOptions extends InspectWorkflowOptions {}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function skippedCompletion(reason: string): CompletionResult {
  return { state: 'UNKNOWN', reasons: [reason], authoritativeSignals: {} };
}

function exitCodeFor(state: EvidenceReport['finalState']): number {
  if (state === 'VERIFIED') return 0;
  if (state === 'NOT_COMPLETED') return 1;
  if (state === 'FAILED') return 3;
  return 2;
}

function preflightChecks(inspection: PageInspection, example: PracticeExample): PreflightCheck[] {
  const exampleAvailable = inspection.lab.examples.some((entry) => entry.id === example.id);
  const identityFields = inspection.identity.fields;
  return [
    {
      name: 'official-alur-url',
      ok: isAllowedAlurPage(inspection.url) && /ALUR/i.test(inspection.title),
      detail: isAllowedAlurPage(inspection.url)
        ? 'The page is the official ALUR origin and path.'
        : `Unexpected page URL: ${clip(inspection.url, 300)}`,
    },
    {
      name: 'page-bootstrapped',
      ok: inspection.bootstrapped,
      detail: inspection.bootstrapped
        ? 'Editor, status, tabs, and main section are present.'
        : 'The ALUR application did not finish initialising.',
    },
    {
      name: 'lab-editor',
      ok: inspection.lab.editor.present,
      detail: inspection.lab.editor.present ? 'The Lab editor is present.' : 'The Lab editor is missing.',
    },
    {
      name: 'no-active-mission',
      ok: !inspection.mission.active,
      detail: inspection.mission.active
        ? 'A graded mission is open in the Lab; the agent refuses to overwrite it with a practice example.'
        : 'No graded mission is open.',
    },
    {
      name: 'identity-fields',
      ok: identityFields.length === 2 && inspection.identity.problems.length === 0,
      detail:
        identityFields.length === 2 && inspection.identity.problems.length === 0
          ? 'The Nama and Kelas fields were found by label and do not conflict with the expected ALUR ids.'
          : `Identity field check failed: ${inspection.identity.problems.join(' ') || 'expected 2 fields'}`,
    },
    {
      name: 'practice-example',
      ok: exampleAvailable,
      detail: exampleAvailable
        ? `The built-in ungraded "${example.title}" example is available.`
        : `The built-in "${example.title}" example is not available.`,
    },
    {
      name: 'no-page-errors',
      ok: inspection.pageErrors.length === 0,
      detail:
        inspection.pageErrors.length === 0
          ? 'No page JavaScript errors were observed.'
          : `Page JavaScript errors: ${inspection.pageErrors.join(' | ')}`,
    },
  ];
}

function failedChecks(checks: PreflightCheck[]): string {
  return checks
    .filter((check) => !check.ok)
    .map((check) => `${check.name}: ${check.detail}`)
    .join(' ');
}

async function action<T>(
  logger: Logger,
  state: string,
  fn: () => Promise<T>,
): Promise<T> {
  const record = logger.beginAction(state);
  try {
    const value = await fn();
    logger.endAction(record, 'ok');
    return value;
  } catch (error) {
    logger.endAction(record, 'error', sanitizeError(error).message);
    throw error;
  }
}

function isApprovalDenial(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'APPROVAL_DENIED'
  );
}

function aiReport(assessment: AgentAssessment | null, model: string): EvidenceReport['ai'] {
  if (!assessment) {
    return {
      status: 'skipped',
      model,
      toolsSupported: null,
      advisory: null,
      proposedAction: null,
      error: null,
    };
  }
  return {
    status: assessment.status,
    model: assessment.model,
    toolsSupported: assessment.toolsSupported,
    advisory: assessment.advisory,
    proposedAction: assessment.proposedAction,
    error: assessment.error,
  };
}

function buildReport(options: {
  config: AgentConfig;
  logger: Logger;
  startedAt: string;
  completedAt: string;
  finalState: EvidenceReport['finalState'];
  inspection: PageInspection | null;
  identity: IdentityVerification | null;
  completion: CompletionResult;
  ai: AgentAssessment | null;
  screenshot: StoredScreenshot | null;
  evidence: PracticeRunEvidence | null;
  failureReason: string | null;
}): EvidenceReport {
  const example = PRACTICE_EXAMPLES[options.config.practiceExample];
  const config = configSummary(options.config);
  const identityVerified = options.identity?.verified === true;
  return {
    schemaVersion: 1,
    runId: options.logger.runId,
    mode: options.config.mode,
    startedAt: options.startedAt,
    completedAt: options.completedAt,
    url: options.inspection?.url ?? options.config.alurUrl,
    title: options.inspection?.title ?? 'ALUR',
    finalState: options.finalState,
    task: {
      kind: 'practice-example',
      exampleId: example.id,
      exampleTitle: example.title,
    },
    identity: {
      verified: identityVerified,
      fieldsFilled: identityVerified ? options.identity?.fields.length ?? 0 : 0,
      storageMatch: options.identity?.storageMatch === true,
    },
    completion: options.completion,
    ai: aiReport(options.ai, options.config.openRouterModel),
    screenshot: options.screenshot
      ? {
          file: options.screenshot.file,
          fullPage: options.screenshot.fullPage,
          width: options.screenshot.width,
          height: options.screenshot.height,
          bytes: options.screenshot.bytes,
          sha256: options.screenshot.sha256,
          fallbackReason: options.screenshot.fallbackReason,
        }
      : null,
    failureReason: options.failureReason,
    actions: options.logger.getActions(),
    config: {
      alurUrl: config.alurUrl,
      headless: config.headless,
      maxAgentSteps: config.maxAgentSteps,
      practiceExample: config.practiceExample,
    },
    pageErrors: options.evidence?.pageErrors ?? options.inspection?.pageErrors ?? [],
    warnings: options.logger.getWarnings(),
  };
}

async function safeClose(port: AlurAutomationPort, logger: Logger): Promise<void> {
  try {
    await action(logger, 'firefox:close', () => port.close());
  } catch (error) {
    logger.warn(`Could not close Firefox cleanly: ${sanitizeError(error).message}`);
  }
}

async function captureEvidence(options: {
  config: AgentConfig;
  port: AlurAutomationPort;
  logger: Logger;
  evidenceStore: EvidenceStore;
  inspection: PageInspection;
  completionState: CompletionResult['state'];
  diagnostic: boolean;
}): Promise<StoredScreenshot> {
  const example = PRACTICE_EXAMPLES[options.config.practiceExample];
  await action(options.logger, 'alur:open-lab-for-evidence', () => options.port.openView('lab'));
  const current = await options.port.inspect();
  if (current.mission.active) {
    throw new WorkflowError(
      'MISSION_ACTIVE_SCREENSHOT',
      'A graded mission became active; refusing to capture it into the evidence store.',
    );
  }
  const capture = await action(options.logger, 'evidence:screenshot', () => options.port.screenshot(true));
  return action(options.logger, 'evidence:store-screenshot', () =>
    options.evidenceStore.saveScreenshot(capture, {
      runId: options.logger.runId,
      url: current.url,
      exampleId: example.id,
      exampleTitle: example.title,
      completionState: options.completionState,
      diagnostic: options.diagnostic,
    }),
  );
}

/**
 * Deterministic approved practice workflow. AI is advisory only. Every
 * mutation is behind a human approval gate, and the run uses only the fixed
 * built-in examples selected by exact id.
 */
export async function runStartWorkflow(options: StartWorkflowOptions): Promise<StartWorkflowResult> {
  const { config, port, logger, evidenceStore, advisor } = options;
  const now = options.now ?? (() => new Date());
  const startedAt = nowIso(now);
  const example = PRACTICE_EXAMPLES[config.practiceExample];

  let inspection: PageInspection | null = null;
  let identity: IdentityVerification | null = null;
  let evidence: PracticeRunEvidence | null = null;
  let assessment: AgentAssessment | null = null;
  let screenshot: StoredScreenshot | null = null;
  let completion = skippedCompletion('Completion was not evaluated.');
  let finalState: EvidenceReport['finalState'] = 'FAILED';
  let failureReason: string | null = null;
  let aborted = false;
  let launched = false;

  try {
    await action(logger, 'firefox:launch', async () => {
      const launchedInfo = await port.launch(config.headless);
      launched = true;
      return launchedInfo;
    });
    await action(logger, 'alur:open', () => port.open());
    inspection = await action(logger, 'alur:inspect', () => port.inspect());

    const checks = preflightChecks(inspection, example);
    if (checks.some((check) => !check.ok)) {
      throw new WorkflowError('PREFLIGHT_FAILED', `Preflight failed. ${failedChecks(checks)}`);
    }
    logger.info('Preflight passed: official ALUR page, no active mission, identity fields, and practice example are available.');

    if (advisor) {
      try {
        assessment = await action(logger, 'ai:preflight-advisory', () =>
          advisor.review({
            stage: 'preflight',
            inspection: inspection!,
            allowedActions: ['fill_identity', 'stop'],
            getPageState: () => port.inspect(),
          }),
        );
        logger.info(
          `AI advisory status=${assessment.status} tools=${String(assessment.toolsSupported)} proposed=${assessment.proposedAction ?? 'none'}.`,
        );
        if (assessment.status === 'failed') {
          const message = assessment.error ?? 'OpenRouter advisory failed.';
          if (config.requireAi) {
            throw new WorkflowError('AI_REQUIRED_FAILED', `AI is required but the advisory failed: ${message}`);
          }
          logger.warn(`AI advisory failed, continuing without it: ${clip(message, 500)}`);
        } else if (assessment.error) {
          logger.warn(`AI advisory degraded: ${clip(assessment.error, 500)}`);
        }
      } catch (error) {
        if (error instanceof WorkflowError) throw error;
        const message = sanitizeError(error).message;
        if (config.requireAi) {
          throw new WorkflowError('AI_REQUIRED_FAILED', `AI is required but the advisory failed: ${message}`);
        }
        logger.warn(`AI advisory could not run, continuing without it: ${message}`);
      }
    } else if (config.requireAi) {
      throw new WorkflowError('AI_REQUIRED_MISSING', 'AI is required by configuration but no advisor was provided.');
    }

    // The MCP server asks the local approval broker immediately before each
    // mutation. Keeping the gate at that boundary protects CLI and direct MCP
    // callers alike.
    identity = await action(logger, 'identity:fill', () =>
      port.fillIdentity({ name: config.studentName, className: config.studentClass }),
    );
    if (!identity.verified) {
      throw new WorkflowError(
        'IDENTITY_NOT_VERIFIED',
        `Identity filling did not verify: ${identity.problems.join(' ') || 'unknown verification failure'}`,
      );
    }
    identity = await action(logger, 'identity:verify', () =>
      port.verifyIdentity({ name: config.studentName, className: config.studentClass }),
    );
    if (!identity.verified) {
      throw new WorkflowError(
        'IDENTITY_NOT_VERIFIED',
        `Identity re-verification failed: ${identity.problems.join(' ') || 'unknown verification failure'}`,
      );
    }

    evidence = await action(logger, 'practice:run', () => port.runPractice(example.id));
    completion = evaluatePracticeCompletion(evidence);
    finalState = completion.state;
    if (completion.state !== 'VERIFIED') {
      failureReason = completion.reasons.join(' ');
      logger.warn(`Practice completion ${completion.state}: ${failureReason}`);
    } else {
      logger.info('Practice completion VERIFIED from URL, exact source, inputs, output, and completion log.');
    }

    try {
      screenshot = await captureEvidence({
        config,
        port,
        logger,
        evidenceStore,
        inspection,
        completionState: completion.state,
        diagnostic: completion.state !== 'VERIFIED',
      });
    } catch (error) {
      const message = sanitizeError(error).message;
      failureReason = failureReason ?? `Completion was ${completion.state}, but screenshot evidence failed: ${message}`;
      if (finalState === 'VERIFIED') finalState = 'UNKNOWN';
      logger.warn(`Screenshot evidence failed: ${message}`);
    }
  } catch (error) {
    if (error instanceof WorkflowAbort || isApprovalDenial(error)) {
      aborted = true;
      finalState = 'ABORTED';
      failureReason = error instanceof Error ? error.message : 'Approval was denied.';
      logger.warn(failureReason);
    } else {
      finalState = 'FAILED';
      failureReason = error instanceof WorkflowError ? error.message : sanitizeError(error).message;
      logger.error('Workflow failed', error);
    }

    if (launched && inspection && !screenshot && !inspection.mission.active) {
      try {
        screenshot = await captureEvidence({
          config,
          port,
          logger,
          evidenceStore,
          inspection,
          completionState: finalState === 'ABORTED' ? 'UNKNOWN' : 'FAILED',
          diagnostic: true,
        });
        logger.info('Captured diagnostic Lab screenshot for the failed run.');
      } catch (captureError) {
        logger.warn(`Could not capture a diagnostic screenshot: ${sanitizeError(captureError).message}`);
      }
    }
  }

  await safeClose(port, logger);

  if (screenshot && finalState === 'VERIFIED' && completion.state !== 'VERIFIED') {
    // Defense in depth: never let a reporting bug turn non-verification into success.
    finalState = completion.state;
  }
  if (!screenshot && finalState === 'VERIFIED') {
    finalState = 'UNKNOWN';
  }

  const report = buildReport({
    config,
    logger,
    startedAt,
    completedAt: nowIso(now),
    finalState,
    inspection,
    identity,
    completion,
    ai: assessment,
    screenshot,
    evidence,
    failureReason,
  });

  let reportFile: string | null = null;
  try {
    const saved: StoredReport = screenshot
      ? await evidenceStore.saveReport(report, screenshot.taskNumber, screenshot.capturedAt)
      : await evidenceStore.saveReportOnly(report);
    reportFile = saved.file;
    logger.info(`Sanitized run report saved to ${saved.file}`);
  } catch (error) {
    logger.error('Could not save the sanitized report', error);
    failureReason = failureReason ?? `Could not save the sanitized report: ${sanitizeError(error).message}`;
    if (finalState === 'VERIFIED') finalState = 'UNKNOWN';
  }

  if (reportFile === null) {
    logger.warn('No report file was saved; inspect the JSONL log for this run.');
  }

  return {
    finalState,
    completion,
    report,
    reportFile,
    screenshot,
    failureReason,
    aborted,
    exitCode: exitCodeFor(finalState),
  };
}

export async function runInspectWorkflow(options: InspectWorkflowOptions): Promise<PageInspection> {
  const { config, port, logger } = options;
  try {
    await action(logger, 'firefox:launch', () => port.launch(config.headless));
    await action(logger, 'alur:open', () => port.open());
    return await action(logger, 'alur:inspect', () => port.inspect());
  } finally {
    await safeClose(port, logger);
  }
}

export async function runDryRunWorkflow(options: DryRunWorkflowOptions): Promise<DryRunResult> {
  const { config, port, logger } = options;
  const example = PRACTICE_EXAMPLES[config.practiceExample];
  let inspection: PageInspection | null = null;
  try {
    await action(logger, 'firefox:launch', () => port.launch(config.headless));
    await action(logger, 'alur:open', () => port.open());
    inspection = await action(logger, 'alur:inspect', () => port.inspect());
    const checks = preflightChecks(inspection, example);
    logger.info(
      checks.every((check) => check.ok)
        ? 'Dry run passed all read-only preflight checks; no page mutations were made.'
        : `Dry run found failed checks: ${failedChecks(checks)}`,
    );
    return { ready: checks.every((check) => check.ok), checks, inspection };
  } finally {
    await safeClose(port, logger);
  }
}
