import type { Locator, Page } from 'playwright';
import { IDENTITY_STORAGE_KEYS } from './site.js';
import type {
  IdentityFieldEvidence,
  IdentityFieldKey,
  IdentityInspection,
  IdentityVerification,
} from './types.js';

interface FieldSpec {
  key: IdentityFieldKey;
  label: string;
  storageKey: string;
}

const FIELD_SPECS: FieldSpec[] = [
  { key: 'name', label: 'Nama', storageKey: IDENTITY_STORAGE_KEYS.name },
  { key: 'class', label: 'Kelas', storageKey: IDENTITY_STORAGE_KEYS.class },
];

interface RawField {
  id: string;
  labels: string[];
  ariaLabel: string;
  placeholder: string;
  type: string;
  visible: boolean;
  disabled: boolean;
  readOnly: boolean;
  valueLength: number;
}

interface ResolvedField {
  spec: FieldSpec;
  raw: RawField;
  locator: Locator;
  selector: string;
}

export class IdentityError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'IdentityError';
    this.code = code;
  }
}

function normalized(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

async function collectRawFields(page: Page): Promise<RawField[]> {
  return page.evaluate(() => {
    const root = document.querySelector('#view-misi');
    if (!root) return [];
    return Array.from(root.querySelectorAll('input')).map((input) => {
      const labels = input.labels ? Array.from(input.labels).map((label) => label.textContent ?? '') : [];
      return {
        id: input.id,
        labels,
        ariaLabel: input.getAttribute('aria-label') ?? '',
        placeholder: input.getAttribute('placeholder') ?? '',
        type: (input.getAttribute('type') ?? 'text').toLowerCase(),
        visible: Boolean(input.offsetWidth || input.offsetHeight || input.getClientRects().length),
        disabled: input.disabled,
        readOnly: input.readOnly,
        valueLength: input.value.length,
      };
    });
  });
}

function labelMatchesSpec(raw: RawField, spec: FieldSpec): boolean {
  return raw.labels.some((label) => normalized(label) === normalized(spec.label));
}

function idLooksLikeSpec(raw: RawField, spec: FieldSpec): boolean {
  return spec.key === 'name' ? raw.id === 'who-name' : raw.id === 'who-class';
}

function cssString(value: string): string {
  return JSON.stringify(value);
}

async function resolveIdentityFields(page: Page): Promise<ResolvedField[]> {
  if ((await page.locator('#view-misi').count()) === 0) {
    throw new IdentityError('MISI_VIEW_MISSING', 'The Misi view is not present on the page.');
  }

  const rawFields = await collectRawFields(page);
  if (rawFields.length === 0) {
    throw new IdentityError('FIELDS_MISSING', 'No text inputs were found in the Misi view.');
  }

  const problems: string[] = [];
  const resolved: ResolvedField[] = [];

  for (const spec of FIELD_SPECS) {
    const matches = rawFields.filter((raw) => labelMatchesSpec(raw, spec));
    if (matches.length === 0) {
      problems.push(`Could not confidently find the "${spec.label}" field by its associated label.`);
      continue;
    }
    if (matches.length > 1) {
      problems.push(`Found ${matches.length} inputs labelled "${spec.label}"; refusing to guess which one to fill.`);
      continue;
    }

    const raw = matches[0]!;
    if (raw.id && !idLooksLikeSpec(raw, spec)) {
      problems.push(
        `The "${spec.label}" label points at input id "${raw.id}", which conflicts with the expected ALUR field.`,
      );
      continue;
    }
    if (!['text', 'search'].includes(raw.type)) {
      problems.push(`The "${spec.label}" field has unsupported input type "${raw.type}".`);
      continue;
    }
    if (raw.disabled || raw.readOnly) {
      problems.push(`The "${spec.label}" field is disabled or read-only.`);
      continue;
    }

    let locator: Locator;
    let selector: string;
    if (raw.id) {
      selector = `#${raw.id}`;
      locator = page.locator(`#view-misi input[id=${cssString(raw.id)}]`);
    } else {
      selector = `label:${spec.label}`;
      locator = page.locator('#view-misi').getByLabel(spec.label, { exact: true });
    }

    if ((await locator.count()) !== 1) {
      problems.push(`The locator for the "${spec.label}" field is not unique.`);
      continue;
    }

    resolved.push({ spec, raw, locator, selector });
  }

  if (problems.length > 0) {
    throw new IdentityError('FIELD_DETECTION_FAILED', problems.join(' '));
  }
  if (resolved.length !== FIELD_SPECS.length) {
    throw new IdentityError('FIELD_DETECTION_FAILED', 'The name and class fields could not both be identified.');
  }

  return resolved;
}

function toEvidence(field: ResolvedField, valueLength: number): IdentityFieldEvidence {
  return {
    key: field.spec.key,
    label: field.spec.label,
    selector: field.selector,
    id: field.raw.id,
    inputType: field.raw.type,
    visible: field.raw.visible,
    valueLength,
    storageKey: field.spec.storageKey,
  };
}

async function readStorage(page: Page): Promise<{ name: unknown; class: unknown }> {
  return page.evaluate(
    ({ nameKey, classKey }) => {
      const read = (key: string): unknown => {
        try {
          const raw = localStorage.getItem(key);
          return raw === null ? null : JSON.parse(raw);
        } catch {
          return null;
        }
      };
      return { name: read(nameKey), class: read(classKey) };
    },
    { nameKey: IDENTITY_STORAGE_KEYS.name, classKey: IDENTITY_STORAGE_KEYS.class },
  );
}

async function waitForStorage(page: Page, expected: { name: string; className: string }): Promise<boolean> {
  try {
    await page.waitForFunction(
      ({ name, className, nameKey, classKey }) => {
        try {
          const storedName = JSON.parse(localStorage.getItem(nameKey) ?? 'null');
          const storedClass = JSON.parse(localStorage.getItem(classKey) ?? 'null');
          return storedName === name && storedClass === className;
        } catch {
          return false;
        }
      },
      {
        name: expected.name,
        className: expected.className,
        nameKey: IDENTITY_STORAGE_KEYS.name,
        classKey: IDENTITY_STORAGE_KEYS.class,
      },
      { timeout: 3_000 },
    );
    return true;
  } catch {
    return false;
  }
}

export async function inspectIdentity(page: Page): Promise<IdentityInspection> {
  try {
    const fields = await resolveIdentityFields(page);
    const storage = await readStorage(page);
    const evidence: IdentityFieldEvidence[] = [];
    for (const field of fields) {
      const valueLength = (await field.locator.inputValue()).length;
      evidence.push(toEvidence(field, valueLength));
    }
    return {
      fields: evidence,
      nameStored: typeof storage.name === 'string' && storage.name.length > 0,
      classStored: typeof storage.class === 'string' && storage.class.length > 0,
      bothVisible: evidence.every((field) => field.visible),
      problems: [],
    };
  } catch (error) {
    return {
      fields: [],
      nameStored: false,
      classStored: false,
      bothVisible: false,
      problems: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export async function fillIdentity(
  page: Page,
  expected: { name: string; className: string },
): Promise<IdentityVerification> {
  const fields = await resolveIdentityFields(page);
  const nameField = fields.find((field) => field.spec.key === 'name')!;
  const classField = fields.find((field) => field.spec.key === 'class')!;

  for (const field of [nameField, classField]) {
    if (!(await field.locator.isVisible())) {
      throw new IdentityError(
        'FIELDS_NOT_VISIBLE',
        `The "${field.spec.label}" field is not visible. Open the Misi tab before filling identity.`,
      );
    }
    await field.locator.scrollIntoViewIfNeeded();
  }

  await nameField.locator.fill(expected.name);
  await classField.locator.fill(expected.className);

  const valuesMatch =
    (await nameField.locator.inputValue()) === expected.name &&
    (await classField.locator.inputValue()) === expected.className;

  const storageObserved = await waitForStorage(page, expected);
  const storage = await readStorage(page);
  const storageMatch = storage.name === expected.name && storage.class === expected.className;

  const evidence: IdentityFieldEvidence[] = [];
  for (const field of fields) {
    const valueLength = (await field.locator.inputValue()).length;
    evidence.push(toEvidence(field, valueLength));
  }

  const problems: string[] = [];
  if (!valuesMatch) problems.push('One or more identity field values did not match after filling.');
  if (!storageMatch) {
    problems.push(
      storageObserved
        ? 'The ALUR page did not store the identity values in localStorage.'
        : 'Timed out waiting for the ALUR page to persist the identity values in localStorage.',
    );
  }

  return {
    verified: valuesMatch && storageMatch,
    valuesMatch,
    storageMatch,
    fields: evidence,
    problems,
  };
}

export async function verifyIdentity(
  page: Page,
  expected: { name: string; className: string },
): Promise<IdentityVerification> {
  const fields = await resolveIdentityFields(page);
  const nameField = fields.find((field) => field.spec.key === 'name')!;
  const classField = fields.find((field) => field.spec.key === 'class')!;

  const nameValue = await nameField.locator.inputValue();
  const classValue = await classField.locator.inputValue();
  const valuesMatch = nameValue === expected.name && classValue === expected.className;

  const storage = await readStorage(page);
  const storageMatch = storage.name === expected.name && storage.class === expected.className;

  const evidence: IdentityFieldEvidence[] = [];
  for (const field of fields) {
    const valueLength = (await field.locator.inputValue()).length;
    evidence.push(toEvidence(field, valueLength));
  }

  const problems: string[] = [];
  if (!valuesMatch) problems.push('The identity fields do not currently contain the configured values.');
  if (!storageMatch) problems.push('The identity values are not persisted in the page storage.');

  return {
    verified: valuesMatch && storageMatch,
    valuesMatch,
    storageMatch,
    fields: evidence,
    problems,
  };
}
