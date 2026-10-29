import { PRACTICE_EXAMPLES, isAllowedAlurPage } from './site.js';
import type {
  CompletionResult,
  MissionCompletionEvidence,
  PracticeRunEvidence,
} from './types.js';

const COMPLETION_LOG = /^Program selesai dalam [\d.,]+ langkah\.$/;

function result(
  state: CompletionResult['state'],
  reasons: string[],
  authoritativeSignals: CompletionResult['authoritativeSignals'],
): CompletionResult {
  return { state, reasons, authoritativeSignals };
}

function practiceSignals(evidence: PracticeRunEvidence): CompletionResult['authoritativeSignals'] {
  return {
    urlIsOfficialAlur: isAllowedAlurPage(evidence.url),
    view: evidence.view,
    status: evidence.status.state,
    errorbarVisible: evidence.error.visible,
    codeSignatureMatched: evidence.codeSignatureMatched,
    inputsValue: evidence.inputsValue,
    consoleEntryCount: evidence.consoleEntryCount,
    completionLogCount: evidence.consoleOutput.filter((line) => COMPLETION_LOG.test(line)).length,
    timedOut: evidence.timedOut,
    pageErrorCount: evidence.pageErrors.length,
  };
}

/**
 * Verifies a built-in, ungraded practice example.
 *
 * The status badge alone is not evidence: ALUR can already show "done" from a
 * previous run or its default example. Verification therefore binds all of:
 * official URL, Lab view, exact example source signature, exact inputs,
 * expected console output, exactly one fresh completion log, no visible
 * errorbar, and no timeout. Anything missing is UNKNOWN, never VERIFIED.
 */
export function evaluatePracticeCompletion(evidence: PracticeRunEvidence): CompletionResult {
  const signals = practiceSignals(evidence);
  const spec = PRACTICE_EXAMPLES[evidence.exampleId as keyof typeof PRACTICE_EXAMPLES];

  if (!isAllowedAlurPage(evidence.url)) {
    return result('FAILED', ['The evidence did not come from the official ALUR page.'], signals);
  }
  if (!spec) {
    return result('FAILED', [`Practice example "${evidence.exampleId}" is not on the allowlist.`], signals);
  }
  if (evidence.view !== 'lab') {
    return result('UNKNOWN', ['The Lab view was not active, so completion cannot be bound to the editor.'], signals);
  }
  if (evidence.timedOut) {
    return result('UNKNOWN', ['The practice run did not reach a terminal state before the timeout.'], signals);
  }
  if (evidence.error.visible || evidence.status.state === 'error') {
    return result('FAILED', ['ALUR reported an error while running the practice example.'], signals);
  }
  if (evidence.status.state !== 'done') {
    return result(
      'NOT_COMPLETED',
      [`ALUR did not report completion (status: ${evidence.status.state || 'missing'}).`],
      signals,
    );
  }

  // A done badge without a matching, fresh evidence bundle must never pass.
  if (evidence.pageErrors.length > 0) {
    return result('UNKNOWN', ['The page logged JavaScript errors during the run.'], signals);
  }
  if (!evidence.codeSignatureMatched) {
    return result(
      'UNKNOWN',
      ['The editor no longer contains the exact built-in practice program, so the done badge is not bound to this task.'],
      signals,
    );
  }
  if (evidence.inputsValue !== spec.inputs) {
    return result(
      'NOT_COMPLETED',
      [`The practice inputs were "${evidence.inputsValue}", not the expected "${spec.inputs}".`],
      signals,
    );
  }
  if (
    evidence.expectedInputs !== spec.inputs ||
    evidence.expectedConsoleLines.join('\u0000') !== spec.expectedConsoleLines.join('\u0000')
  ) {
    return result('UNKNOWN', ['The expected evidence bundle did not match the allowlisted example definition.'], signals);
  }

  const missing = spec.expectedConsoleLines.filter((line) => !evidence.consoleOutput.includes(line));
  if (missing.length > 0) {
    return result(
      'NOT_COMPLETED',
      [`Expected output was not observed: ${missing.map((line) => JSON.stringify(line)).join(', ')}.`],
      signals,
    );
  }

  const completionLogs = evidence.consoleOutput.filter((line) => COMPLETION_LOG.test(line));
  if (completionLogs.length !== 1) {
    return result(
      'UNKNOWN',
      [`Expected exactly one fresh completion log, found ${completionLogs.length}.`],
      signals,
    );
  }

  const started = Date.parse(evidence.startedAt);
  const finished = Date.parse(evidence.finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) {
    return result('UNKNOWN', ['The run timestamps were missing or inconsistent.'], signals);
  }

  return result(
    'VERIFIED',
    [
      `The allowlisted "${spec.title}" example completed with the exact source, inputs, output, and one completion log.`,
    ],
    signals,
  );
}

/**
 * Mission completion is evaluated only from ALUR's stored mission state plus
 * the rendered card/summary. This project does not autonomously attempt
 * graded missions; the evaluator exists so callers never mistake a toast or a
 * selected card for proof of completion.
 */
export function evaluateMissionCompletion(evidence: MissionCompletionEvidence): CompletionResult {
  const normalizedCard = evidence.cardState?.trim().toLowerCase() ?? '';
  const signals: CompletionResult['authoritativeSignals'] = {
    urlIsOfficialAlur: isAllowedAlurPage(evidence.url),
    selectedMissionId: evidence.selectedMissionId ?? 'none',
    expectedMissionId: evidence.expectedMissionId,
    cardState: evidence.cardState ?? 'none',
    summaryVisible: evidence.summaryVisible,
    summaryOk: evidence.summaryOk,
    storedState: evidence.storedState ?? 'none',
  };

  if (!isAllowedAlurPage(evidence.url)) {
    return result('FAILED', ['The mission evidence did not come from the official ALUR page.'], signals);
  }
  if (!evidence.expectedMissionId) {
    return result('FAILED', ['No expected mission id was supplied.'], signals);
  }
  if (evidence.selectedMissionId !== evidence.expectedMissionId) {
    return result(
      'UNKNOWN',
      ['The expected mission was not selected, so its stored state cannot be bound to the visible result.'],
      signals,
    );
  }
  if (evidence.storedState !== 'done') {
    return result(
      'NOT_COMPLETED',
      [`ALUR's authoritative mission state is ${evidence.storedState ? `"${evidence.storedState}"` : 'absent'}, not "done".`],
      signals,
    );
  }
  if (normalizedCard !== 'lulus' && normalizedCard !== 'done') {
    return result('UNKNOWN', ['The stored mission state and the rendered mission card disagree.'], signals);
  }
  if (!evidence.summaryVisible) {
    return result('UNKNOWN', ['The mission result summary is not visible, so completion cannot be confirmed.'] , signals);
  }
  if (!evidence.summaryOk) {
    return result('UNKNOWN', ['The stored state says done but the visible result summary does not.'], signals);
  }

  return result(
    'VERIFIED',
    ['ALUR stored the mission as done and the visible card and passing summary agree.'],
    signals,
  );
}
