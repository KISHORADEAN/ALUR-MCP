import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAssessment } from '../src/agent.js';
import { ApprovalGate } from '../src/approvals.js';
import { McpClientError } from '../src/mcp-client.js';
import type { AgentConfig } from '../src/config.js';
import { Logger } from '../src/logger.js';
import { EvidenceStore } from '../src/screenshot.js';
import { DEFAULT_ALUR_URL, PRACTICE_EXAMPLES } from '../src/site.js';
import type {
  IdentityVerification,
  PageInspection,
  PracticeRunEvidence,
} from '../src/types.js';
import {
  runStartWorkflow,
  type Advisor,
  type AlurAutomationPort,
} from '../src/workflow.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

let directory: string;
let config: AgentConfig;
let logger: Logger;

function inspection(): PageInspection {
  return {
    url: DEFAULT_ALUR_URL,
    title: 'ALUR · Lab Maya Pseudocode',
    view: 'lab',
    bootstrapped: true,
    navTabs: [
      { view: 'lab', label: 'Lab', selected: true },
      { view: 'misi', label: 'Misi 0/12', selected: false },
    ],
    identity: {
      fields: [
        {
          key: 'name',
          label: 'Nama',
          selector: '#who-name',
          id: 'who-name',
          inputType: 'text',
          visible: false,
          valueLength: 0,
          storageKey: 'lmp.name',
        },
        {
          key: 'class',
          label: 'Kelas',
          selector: '#who-class',
          id: 'who-class',
          inputType: 'text',
          visible: false,
          valueLength: 0,
          storageKey: 'lmp.kelas',
        },
      ],
      nameStored: false,
      classStored: false,
      bothVisible: false,
      problems: [],
    },
    lab: {
      status: { state: 'done', text: 'Selesai · 22 langkah' },
      consoleOutput: ['Rata-rata: 80', 'Program selesai dalam 22 langkah.'],
      consoleEntryCount: 2,
      error: { visible: false, text: '' },
      editor: { present: true, length: 500, knownPracticeSignatures: ['rata'] },
      inputsLength: 14,
      examples: [
        { id: PRACTICE_EXAMPLES.faktorial.id, title: PRACTICE_EXAMPLES.faktorial.title },
        { id: PRACTICE_EXAMPLES.rata.id, title: PRACTICE_EXAMPLES.rata.title },
      ],
    },
    mission: { active: false, countText: '0/12', selected: null, summary: null, cards: [] },
    pageErrors: [],
  };
}

function verifiedIdentity(): IdentityVerification {
  return {
    verified: true,
    valuesMatch: true,
    storageMatch: true,
    fields: inspection().identity.fields,
    problems: [],
  };
}

function verifiedEvidence(): PracticeRunEvidence {
  const example = PRACTICE_EXAMPLES.faktorial;
  return {
    exampleId: example.id,
    expectedInputs: example.inputs,
    expectedConsoleLines: [...example.expectedConsoleLines],
    startedAt: '2026-10-29T02:00:00.000Z',
    finishedAt: '2026-10-29T02:00:01.000Z',
    durationMs: 1_000,
    url: DEFAULT_ALUR_URL,
    view: 'lab',
    codeSignatureMatched: true,
    inputsValue: example.inputs,
    status: { state: 'done', text: 'Selesai · 17 langkah' },
    consoleOutput: ['n = 4', '24', 'Program selesai dalam 17 langkah.'],
    consoleEntryCount: 3,
    error: { visible: false, text: '' },
    timedOut: false,
    pageErrors: [],
  };
}

function fakePort(overrides: {
  evidence?: PracticeRunEvidence;
  fillIdentity?: () => Promise<IdentityVerification>;
} = {}): AlurAutomationPort {
  const identity = verifiedIdentity();
  return {
    launch: vi.fn(async () => ({ browser: 'firefox' as const, headless: true })),
    open: vi.fn(async () => ({ url: DEFAULT_ALUR_URL, title: 'ALUR · Lab Maya Pseudocode' })),
    inspect: vi.fn(async () => inspection()),
    openView: vi.fn(async () => ({ view: 'lab' as const, visible: true })),
    fillIdentity: vi.fn(overrides.fillIdentity ?? (async () => identity)),
    verifyIdentity: vi.fn(async () => identity),
    runPractice: vi.fn(async () => overrides.evidence ?? verifiedEvidence()),
    screenshot: vi.fn(async () => ({
      buffer: PNG_1X1,
      fullPage: true,
      fallbackReason: null,
      width: 1,
      height: 1,
    })),
    close: vi.fn(async () => {}),
  };
}

function fakeAdvisor(assessment: Partial<AgentAssessment> = {}): Advisor {
  return {
    review: vi.fn(async () => ({
      status: 'ok' as const,
      model: 'openrouter/free',
      toolsSupported: true,
      advisory: 'Proceed with the approved practice step.',
      proposedAction: 'fill_identity' as const,
      error: null,
      capability: { checked: true, found: true, toolsSupported: true, contextLength: 200_000, error: null },
      ...assessment,
    })),
  };
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'alur-workflow-test-'));
  config = {
    cwd: directory,
    alurUrl: DEFAULT_ALUR_URL,
    openRouterApiKey: '',
    openRouterModel: 'openrouter/free',
    studentName: 'Test Student',
    studentClass: '9C',
    headless: true,
    maxAgentSteps: 10,
    openRouterTimeoutMs: 45_000,
    practiceExample: 'faktorial',
    evidenceDir: path.join(directory, 'evidence'),
    logDir: path.join(directory, 'logs'),
    requireAi: false,
    requireIdentity: true,
    mode: 'start',
  };
  logger = new Logger({ dir: config.logDir, runId: `test-${Date.now()}`, mode: 'start', terminal: false });
});

afterEach(async () => {
  logger.close();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('runStartWorkflow', () => {
  it('runs the approved practice flow and saves sanitized evidence', async () => {
    const port = fakePort();
    const advisor = fakeAdvisor();
    const result = await runStartWorkflow({
      config,
      port,
      logger,
      evidenceStore: new EvidenceStore({ directory: config.evidenceDir, cwd: config.cwd }),
      advisor,
    });

    expect(result.finalState).toBe('VERIFIED');
    expect(result.exitCode).toBe(0);
    expect(result.reportFile).not.toBeNull();
    expect(result.screenshot?.file).toMatch(/^evidence\/\d{4}-\d{2}-\d{2}\/task-\d{3}\.png$/);
    expect(result.report.ai.status).toBe('ok');
    expect(result.report.identity).toMatchObject({ verified: true, fieldsFilled: 2, storageMatch: true });
    expect(port.fillIdentity).toHaveBeenCalledOnce();
    expect(port.runPractice).toHaveBeenCalledWith('faktorial');

    const reportPath = path.resolve(config.cwd, result.reportFile!);
    const reportText = await fs.readFile(reportPath, 'utf8');
    expect(reportText).not.toContain('Test Student');
    expect(reportText).not.toContain('9C');
    expect(reportText).toContain('"finalState": "VERIFIED"');

    const sidecar = await readJson(
      path.resolve(config.cwd, result.screenshot!.file.replace(/\.png$/, '.json')),
    );
    expect(sidecar).toMatchObject({ kind: 'screenshot-evidence', completionState: 'VERIFIED', diagnostic: false });
    expect(JSON.stringify(sidecar)).not.toContain('Test Student');

    const screenshot = await fs.readFile(path.resolve(config.cwd, result.screenshot!.file));
    expect(screenshot.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  it('aborts when the MCP mutation boundary denies approval', async () => {
    const port = fakePort({
      fillIdentity: async () => {
        throw new McpClientError(
          'APPROVAL_DENIED',
          'Approval denied at the MCP mutation boundary.',
          'alur_fill_identity',
        );
      },
    });
    const result = await runStartWorkflow({
      config,
      port,
      logger,
      evidenceStore: new EvidenceStore({ directory: config.evidenceDir, cwd: config.cwd }),
    });

    expect(result.finalState).toBe('ABORTED');
    expect(result.aborted).toBe(true);
    expect(result.exitCode).toBe(2);
    expect(port.fillIdentity).toHaveBeenCalledOnce();
    expect(port.runPractice).not.toHaveBeenCalled();
    expect(result.reportFile).not.toBeNull();
    expect(result.report.finalState).toBe('ABORTED');
  });

  it('fails safely when AI is required but unavailable', async () => {
    config.requireAi = true;
    const port = fakePort();
    const result = await runStartWorkflow({
      config,
      port,
      logger,
      evidenceStore: new EvidenceStore({ directory: config.evidenceDir, cwd: config.cwd }),
      advisor: fakeAdvisor({ status: 'failed', error: 'network down', advisory: null, proposedAction: null }),
    });

    expect(result.finalState).toBe('FAILED');
    expect(result.exitCode).toBe(3);
    expect(port.fillIdentity).not.toHaveBeenCalled();
    expect(result.report.ai.status).toBe('failed');
    expect(result.report.failureReason).toContain('AI is required');
  });

  it('does not verify a done badge when the source signature is wrong', async () => {
    const port = fakePort({ evidence: { ...verifiedEvidence(), codeSignatureMatched: false } });
    const result = await runStartWorkflow({
      config,
      port,
      logger,
      evidenceStore: new EvidenceStore({ directory: config.evidenceDir, cwd: config.cwd }),
    });

    expect(result.completion.state).toBe('UNKNOWN');
    expect(result.finalState).toBe('UNKNOWN');
    expect(result.exitCode).toBe(2);
    expect(result.reportFile).not.toBeNull();
    const sidecar = await readJson(
      path.resolve(config.cwd, result.screenshot!.file.replace(/\.png$/, '.json')),
    );
    expect(sidecar).toMatchObject({ diagnostic: true, completionState: 'UNKNOWN' });
  });

  it('uses an interactive approval gate without defaulting to yes', async () => {
    const input = new PassThrough() as PassThrough & { isTTY?: boolean };
    const output = new PassThrough() as PassThrough & { isTTY?: boolean };
    input.isTTY = false;
    output.isTTY = false;
    const gate = new ApprovalGate({ autoApprove: false, input, output });
    const decision = await gate.approve({
      stage: 'test',
      action: 'test',
      details: ['test'],
    });
    expect(decision.approved).toBe(false);
    expect(decision.source).toBe('non-interactive');
  });
});
