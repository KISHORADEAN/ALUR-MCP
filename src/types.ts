export type CompletionState = 'VERIFIED' | 'NOT_COMPLETED' | 'UNKNOWN' | 'FAILED';

export type IdentityFieldKey = 'name' | 'class';

export interface IdentityFieldEvidence {
  key: IdentityFieldKey;
  label: string;
  selector: string;
  id: string;
  inputType: string;
  visible: boolean;
  valueLength: number;
  storageKey: string;
}

export interface IdentityInspection {
  fields: IdentityFieldEvidence[];
  nameStored: boolean;
  classStored: boolean;
  bothVisible: boolean;
  problems: string[];
}

export interface IdentityVerification {
  verified: boolean;
  valuesMatch: boolean;
  storageMatch: boolean;
  fields: IdentityFieldEvidence[];
  problems: string[];
}

export interface PageStatus {
  state: string;
  text: string;
}

export interface PageInspection {
  url: string;
  title: string;
  view: string;
  bootstrapped: boolean;
  navTabs: Array<{ view: string; label: string; selected: boolean }>;
  identity: IdentityInspection;
  lab: {
    status: PageStatus;
    consoleOutput: string[];
    consoleEntryCount: number;
    error: { visible: boolean; text: string };
    editor: {
      present: boolean;
      length: number;
      knownPracticeSignatures: string[];
    };
    inputsLength: number;
    examples: Array<{ id: string; title: string }>;
  };
  mission: {
    active: boolean;
    countText: string;
    selected: {
      id: string;
      title: string;
      state: string;
      task: string;
      hint: string;
    } | null;
    summary: { visible: boolean; ok: boolean; text: string } | null;
    cards: Array<{ id: string; title: string; state: string; selected: boolean }>;
  };
  pageErrors: string[];
}

export interface PracticeRunEvidence {
  exampleId: string;
  expectedInputs: string;
  expectedConsoleLines: string[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  url: string;
  view: string;
  codeSignatureMatched: boolean;
  inputsValue: string;
  status: PageStatus;
  consoleOutput: string[];
  consoleEntryCount: number;
  error: { visible: boolean; text: string };
  timedOut: boolean;
  pageErrors: string[];
}

export interface CompletionResult {
  state: CompletionState;
  reasons: string[];
  authoritativeSignals: Record<string, string | number | boolean>;
}

export interface MissionCompletionEvidence {
  url: string;
  selectedMissionId: string | null;
  expectedMissionId: string;
  cardState: string | null;
  summaryVisible: boolean;
  summaryOk: boolean;
  storedState: string | null;
}

export interface ActionRecord {
  state: string;
  status: 'ok' | 'error' | 'skipped' | 'pending';
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  detail?: string;
}

export interface EvidenceReport {
  schemaVersion: 1;
  runId: string;
  mode: string;
  startedAt: string;
  completedAt: string;
  url: string;
  title: string;
  finalState: CompletionState | 'ABORTED' | 'INTERRUPTED';
  task: {
    kind: 'practice-example';
    exampleId: string;
    exampleTitle: string;
  };
  identity: {
    verified: boolean;
    fieldsFilled: number;
    storageMatch: boolean;
  };
  completion: CompletionResult;
  ai: {
    status: 'ok' | 'degraded' | 'skipped' | 'failed';
    model: string;
    toolsSupported: boolean | null;
    advisory: string | null;
    proposedAction: string | null;
    error: string | null;
  };
  screenshot: {
    file: string;
    fullPage: boolean;
    width: number | null;
    height: number | null;
    bytes: number;
    sha256: string;
    fallbackReason: string | null;
  } | null;
  failureReason: string | null;
  actions: ActionRecord[];
  config: {
    alurUrl: string;
    headless: boolean;
    maxAgentSteps: number;
    practiceExample: string;
  };
  pageErrors: string[];
  warnings: string[];
}
