import { describe, expect, it } from 'vitest';
import { evaluateMissionCompletion, evaluatePracticeCompletion } from '../src/completion.js';
import { DEFAULT_ALUR_URL, PRACTICE_EXAMPLES } from '../src/site.js';
import type { MissionCompletionEvidence, PracticeRunEvidence } from '../src/types.js';

function practice(overrides: Partial<PracticeRunEvidence> = {}): PracticeRunEvidence {
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
    ...overrides,
  };
}

function mission(overrides: Partial<MissionCompletionEvidence> = {}): MissionCompletionEvidence {
  return {
    url: DEFAULT_ALUR_URL,
    selectedMissionId: 'm6',
    expectedMissionId: 'm6',
    cardState: 'Lulus',
    summaryVisible: true,
    summaryOk: true,
    storedState: 'done',
    ...overrides,
  };
}

describe('evaluatePracticeCompletion', () => {
  it('verifies only a fully bound, fresh practice run', () => {
    const result = evaluatePracticeCompletion(practice());
    expect(result.state).toBe('VERIFIED');
    expect(result.authoritativeSignals.completionLogCount).toBe(1);
    expect(result.authoritativeSignals.urlIsOfficialAlur).toBe(true);
  });

  it('does not trust a done badge with the wrong source signature', () => {
    const result = evaluatePracticeCompletion(practice({ codeSignatureMatched: false }));
    expect(result.state).toBe('UNKNOWN');
    expect(result.reasons.join(' ')).toContain('exact built-in practice program');
  });

  it('does not trust a done badge without a fresh completion log', () => {
    const result = evaluatePracticeCompletion(
      practice({ consoleOutput: ['n = 4', '24'], consoleEntryCount: 2 }),
    );
    expect(result.state).toBe('UNKNOWN');
    expect(result.reasons.join(' ')).toContain('exactly one fresh completion log');
  });

  it('rejects duplicate/stale-looking completion logs', () => {
    const result = evaluatePracticeCompletion(
      practice({
        consoleOutput: [
          'n = 4',
          '24',
          'Program selesai dalam 17 langkah.',
          'Program selesai dalam 17 langkah.',
        ],
        consoleEntryCount: 4,
      }),
    );
    expect(result.state).toBe('UNKNOWN');
  });

  it('does not verify when the expected output is missing', () => {
    const result = evaluatePracticeCompletion(
      practice({ consoleOutput: ['n = 4', 'Program selesai dalam 17 langkah.'] }),
    );
    expect(result.state).toBe('NOT_COMPLETED');
  });

  it('does not verify when the inputs differ', () => {
    const result = evaluatePracticeCompletion(practice({ inputsValue: '5' }));
    expect(result.state).toBe('NOT_COMPLETED');
  });

  it('reports an evaluation error as FAILED', () => {
    const result = evaluatePracticeCompletion(
      practice({
        status: { state: 'error', text: 'Galat saat berjalan' },
        error: { visible: true, text: 'Terjadi kesalahan' },
      }),
    );
    expect(result.state).toBe('FAILED');
  });

  it('reports a terminal timeout as UNKNOWN', () => {
    const result = evaluatePracticeCompletion(practice({ timedOut: true }));
    expect(result.state).toBe('UNKNOWN');
  });

  it('reports an incomplete run state as NOT_COMPLETED', () => {
    const result = evaluatePracticeCompletion(
      practice({ status: { state: 'idle', text: 'Siap' } }),
    );
    expect(result.state).toBe('NOT_COMPLETED');
  });

  it('rejects evidence from outside the official ALUR page', () => {
    const result = evaluatePracticeCompletion(practice({ url: 'https://example.com/ALUR/' }));
    expect(result.state).toBe('FAILED');
  });

  it('rejects an altered expected-evidence bundle', () => {
    const result = evaluatePracticeCompletion(
      practice({ expectedConsoleLines: ['999'], inputsValue: PRACTICE_EXAMPLES.faktorial.inputs }),
    );
    expect(result.state).toBe('UNKNOWN');
  });

  it('rejects page JavaScript errors as unprovable', () => {
    const result = evaluatePracticeCompletion(practice({ pageErrors: ['ReferenceError: x'] }));
    expect(result.state).toBe('UNKNOWN');
  });

  it('can verify the rata example against its canonical outputs', () => {
    const example = PRACTICE_EXAMPLES.rata;
    const result = evaluatePracticeCompletion({
      ...practice(),
      exampleId: example.id,
      expectedInputs: example.inputs,
      expectedConsoleLines: [...example.expectedConsoleLines],
      inputsValue: example.inputs,
      consoleOutput: [
        'nilai = 80',
        'nilai = 90',
        'nilai = 70',
        'nilai = -1',
        'Rata-rata: 80',
        'Total siswa: 3',
        'Program selesai dalam 22 langkah.',
      ],
      consoleEntryCount: 7,
    });
    expect(result.state).toBe('VERIFIED');
  });
});

describe('evaluateMissionCompletion', () => {
  it('requires stored done state plus matching visible card and summary', () => {
    expect(evaluateMissionCompletion(mission()).state).toBe('VERIFIED');
  });

  it('does not treat a selected mission as completed', () => {
    const result = evaluateMissionCompletion(mission({ storedState: 'wip', cardState: 'Dikerjakan' }));
    expect(result.state).toBe('NOT_COMPLETED');
  });

  it('returns UNKNOWN when the stored state cannot be bound to the selected mission', () => {
    const result = evaluateMissionCompletion(mission({ selectedMissionId: 'm1' }));
    expect(result.state).toBe('UNKNOWN');
  });

  it('returns UNKNOWN if the passing summary is not visible', () => {
    const result = evaluateMissionCompletion(mission({ summaryVisible: false }));
    expect(result.state).toBe('UNKNOWN');
  });

  it('returns UNKNOWN when stored state and card conflict', () => {
    const result = evaluateMissionCompletion(mission({ cardState: 'Belum' }));
    expect(result.state).toBe('UNKNOWN');
  });

  it('rejects evidence from outside ALUR', () => {
    expect(evaluateMissionCompletion(mission({ url: 'https://example.com/' })).state).toBe('FAILED');
  });
});
