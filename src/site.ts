/**
 * Site-specific constants verified against the live ALUR page on 2026-10-29.
 * These are intentionally narrow: the agent may only operate on the official
 * ALUR origin and the built-in, ungraded practice examples.
 */

export const ALUR_ORIGIN = 'https://ramli-labs.github.io';
export const ALUR_PATH = '/ALUR/';
export const DEFAULT_ALUR_URL = `${ALUR_ORIGIN}${ALUR_PATH}`;

export const ALUR_VIEWS = ['lab', 'rakit', 'susun', 'misi', 'notasi'] as const;
export type AlurView = (typeof ALUR_VIEWS)[number];

export interface PracticeExample {
  id: 'faktorial' | 'rata';
  title: string;
  inputs: string;
  codeSignature: string;
  expectedConsoleLines: string[];
  description: string;
}

/**
 * Built-in examples from the public site's own example selector. They are
 * ungraded demos, not LKPD missions. The run never edits the example source.
 */
export const PRACTICE_EXAMPLES: Record<PracticeExample['id'], PracticeExample> = {
  faktorial: {
    id: 'faktorial',
    title: 'Faktorial n',
    inputs: '4',
    codeSignature: 'Menghitung faktorial n dengan SELAMA',
    expectedConsoleLines: ['24'],
    description: 'Built-in demo that computes 4! = 24 using a SELAMA loop.',
  },
  rata: {
    id: 'rata',
    title: 'Rata-rata nilai',
    inputs: '80, 90, 70, -1',
    codeSignature: 'Menghitung rata-rata nilai dari daftar siswa',
    expectedConsoleLines: ['Rata-rata: 80', 'Total siswa: 3'],
    description: 'Built-in sentinel-loop demo that computes an average of 80.',
  },
};

export const IDENTITY_STORAGE_KEYS = {
  name: 'lmp.name',
  class: 'lmp.kelas',
} as const;

export function normalizeAlurUrl(raw: string): { url?: string; error?: string } {
  const value = raw.trim();
  if (!value) return { error: 'ALUR_URL is empty.' };

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { error: `ALUR_URL is not a valid URL: "${value}".` };
  }

  if (parsed.protocol !== 'https:') {
    return { error: 'ALUR_URL must use https.' };
  }
  if (parsed.origin !== ALUR_ORIGIN) {
    return {
      error: `ALUR_URL must use the official origin ${ALUR_ORIGIN}; got ${parsed.origin}.`,
    };
  }
  if (parsed.pathname !== ALUR_PATH && parsed.pathname !== `${ALUR_PATH}index.html`) {
    return { error: `ALUR_URL must point to ${ALUR_PATH} on the official site.` };
  }

  return { url: DEFAULT_ALUR_URL };
}

export function isAllowedAlurPage(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return (
      parsed.protocol === 'https:' &&
      parsed.origin === ALUR_ORIGIN &&
      (parsed.pathname === ALUR_PATH || parsed.pathname === `${ALUR_PATH}index.html`)
    );
  } catch {
    return false;
  }
}

export function isAlurView(value: string): value is AlurView {
  return (ALUR_VIEWS as readonly string[]).includes(value);
}

export function isPracticeExampleId(value: string): value is PracticeExample['id'] {
  return Object.prototype.hasOwnProperty.call(PRACTICE_EXAMPLES, value);
}
