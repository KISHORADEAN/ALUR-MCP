import { firefox, type Browser, type BrowserContext, type Page } from 'playwright';
import { clip, safePageText } from './redact.js';
import {
  PRACTICE_EXAMPLES,
  isAllowedAlurPage,
  isAlurView,
  type AlurView,
  type PracticeExample,
} from './site.js';
import { fillIdentity, inspectIdentity, verifyIdentity } from './identity.js';
import type {
  IdentityVerification,
  PageInspection,
  PracticeRunEvidence,
} from './types.js';

export class BrowserError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'BrowserError';
    this.code = code;
  }
}

interface LaunchOptions {
  headless: boolean;
  alurUrl: string;
  viewport?: { width: number; height: number };
}

interface ScreenshotResult {
  buffer: Buffer;
  fullPage: boolean;
  fallbackReason: string | null;
  width: number | null;
  height: number | null;
}

const MAX_SCREENSHOT_BYTES = 3_000_000;

function pngDimensions(buffer: Buffer): { width: number; height: number } | null {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function isPng(buffer: Buffer): boolean {
  return pngDimensions(buffer) !== null;
}

export class FirefoxBrowser {
  private readonly options: LaunchOptions;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private pageErrors: string[] = [];
  private launchedHeadless: boolean | null = null;

  constructor(options: LaunchOptions) {
    this.options = options;
  }

  async launch(headless = this.options.headless): Promise<{ browser: 'firefox'; headless: boolean }> {
    if (this.browser) return { browser: 'firefox', headless: this.launchedHeadless ?? headless };

    try {
      this.browser = await firefox.launch({ headless, timeout: 45_000 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Executable doesn't exist|browserType\.launch/i.test(message)) {
        throw new BrowserError(
          'FIREFOX_NOT_INSTALLED',
          `Playwright could not launch Firefox. Run "npx playwright install firefox" and try again. ${clip(message, 300)}`,
        );
      }
      throw new BrowserError('FIREFOX_LAUNCH_FAILED', `Could not launch Playwright Firefox: ${clip(message, 500)}`);
    }

    if (this.browser.browserType().name() !== 'firefox') {
      await this.browser.close().catch(() => {});
      this.browser = null;
      throw new BrowserError('WRONG_BROWSER', 'The launched browser was not Firefox; refusing to continue.');
    }

    this.context = await this.browser.newContext({
      viewport: this.options.viewport ?? { width: 1440, height: 900 },
      locale: 'id-ID',
      serviceWorkers: 'block',
    });
    // tsx/esbuild can emit a __name helper into serialized page callbacks.
    // Define a harmless page-world shim before any ALUR script runs.
    await this.context.addInitScript({
      content:
        'globalThis.__name = globalThis.__name || function (target) { return target; };',
    });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(10_000);
    this.page.setDefaultNavigationTimeout(45_000);
    this.page.on('pageerror', (error) => {
      this.pageErrors.push(clip(error.message, 400));
      if (this.pageErrors.length > 10) this.pageErrors.shift();
    });
    this.launchedHeadless = headless;
    this.page.on('dialog', (dialog) => {
      void dialog.dismiss().catch(() => {});
    });
    this.context.on('page', (popup) => {
      if (popup !== this.page) void popup.close().catch(() => {});
    });

    return { browser: 'firefox', headless };
  }

  async open(): Promise<{ url: string; title: string }> {
    const page = this.requirePage();
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const response = await page.goto(this.options.alurUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 45_000,
        });
        if (response && response.status() >= 400) {
          throw new BrowserError(
            'HTTP_ERROR',
            `ALUR returned HTTP ${response.status()} ${response.statusText()} while opening ${this.options.alurUrl}.`,
          );
        }

        await page.waitForSelector('#code', { state: 'attached', timeout: 20_000 });
        await page.waitForSelector('.views button[data-view]', { state: 'visible', timeout: 20_000 });

        const url = page.url();
        if (!isAllowedAlurPage(url)) {
          throw new BrowserError(
            'UNEXPECTED_PAGE',
            `Firefox landed on an unexpected URL (${clip(url, 300)}). Refusing to interact with it.`,
          );
        }
        const title = await page.title();
        if (!/ALUR/i.test(title)) {
          throw new BrowserError('UNEXPECTED_PAGE', `The ALUR page did not load (title: "${clip(title, 120)}").`);
        }

        return { url, title };
      } catch (error) {
        lastError = error;
        if (attempt === 1) {
          await new Promise((resolve) => setTimeout(resolve, 750));
          continue;
        }
      }
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError);
    if (lastError instanceof BrowserError) throw lastError;
    throw new BrowserError(
      'NAVIGATION_FAILED',
      `Could not open ALUR after 2 attempts: ${clip(message, 500)}`,
    );
  }

  async openView(view: AlurView): Promise<{ view: AlurView; visible: boolean }> {
    if (!isAlurView(view)) {
      throw new BrowserError('INVALID_VIEW', `Unknown ALUR view "${String(view)}".`);
    }
    const page = this.requireAlurPage();
    const tab = page.locator(`.views button[data-view=${JSON.stringify(view)}]`);
    if ((await tab.count()) !== 1) {
      throw new BrowserError('VIEW_NOT_FOUND', `The "${view}" tab was not found on the ALUR page.`);
    }
    await tab.click();
    await page.waitForFunction(
      (target) => {
        const button = document.querySelector(`.views button[data-view="${target}"]`);
        const section = document.querySelector(`#view-${target}`);
        return button?.getAttribute('aria-selected') === 'true' && section instanceof HTMLElement && !section.hidden;
      },
      view,
      { timeout: 10_000 },
    );
    if (view === 'misi') {
      await page.locator('#view-misi input[type="text"]').first().waitFor({ state: 'visible', timeout: 10_000 });
    }
    return { view, visible: true };
  }

  async inspect(): Promise<PageInspection> {
    const page = this.requireAlurPage();

    const practiceEntries = Object.values(PRACTICE_EXAMPLES);
    const snapshot = await page.evaluate(
      ({ signatures }) => {
        const text = (element: Element | null, max = 2_000): string => {
          if (!element) return '';
          return (element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
        };
        const selectedTab = document.querySelector<HTMLElement>('.views button[aria-selected="true"]');
        const visibleSection = Array.from(document.querySelectorAll<HTMLElement>('main section[id^="view-"]')).find(
          (section) => !section.hidden,
        );
        const view = selectedTab?.dataset.view ?? visibleSection?.id.replace('view-', '') ?? 'unknown';

        const navTabs = Array.from(document.querySelectorAll<HTMLElement>('.views button[data-view]')).map((button) => ({
          view: button.dataset.view ?? '',
          label: text(button, 120),
          selected: button.getAttribute('aria-selected') === 'true',
        }));

        const status = document.querySelector<HTMLElement>('#status');
        const consoleEntries = Array.from(document.querySelectorAll<HTMLElement>('#console .o'));
        const consoleOutput = consoleEntries.slice(-20).map((entry) => text(entry, 300));
        const errorbar = document.querySelector<HTMLElement>('#errbar');
        const editor = document.querySelector<HTMLTextAreaElement>('#code');
        const inputs = document.querySelector<HTMLInputElement>('#inputs');
        const exampleSelect = document.querySelector<HTMLSelectElement>('#sel-example');
        const examples = exampleSelect
          ? Array.from(exampleSelect.options)
              .filter((option) => option.value)
              .slice(0, 20)
              .map((option) => ({ id: option.value, title: text(option, 160) }))
          : [];

        const missionStrip = document.querySelector<HTMLElement>('#mission-strip');
        const selectedCard = document.querySelector<HTMLElement>('.mcard[aria-current="true"]');
        const detail = document.querySelector<HTMLElement>('#misi-detail');
        const hint = detail?.querySelector<HTMLElement>('details.hintbox p') ?? null;
        const taskParagraph = detail?.querySelector<HTMLElement>(':scope > p') ?? null;
        const summaryElement =
          document.querySelector<HTMLElement>('#ms-results:not([hidden]) .ms-summary') ??
          document.querySelector<HTMLElement>('#misi-detail .result-line:not([hidden])');
        const summaryVisible = summaryElement
          ? !summaryElement.hidden &&
            (summaryElement.offsetWidth > 0 || summaryElement.offsetHeight > 0 || summaryElement.getClientRects().length > 0)
          : false;

        const cards = Array.from(document.querySelectorAll<HTMLElement>('.mcard'))
          .slice(0, 12)
          .map((card) => ({
            id: card.dataset.id ?? '',
            title: text(card.querySelector('.mtitle'), 160),
            state: text(card.querySelector('.mstate'), 40),
            selected: card.getAttribute('aria-current') === 'true',
          }));

        const code = editor?.value ?? '';
        const knownPracticeSignatures = signatures
          .filter((entry) => code.includes(entry.signature))
          .map((entry) => entry.id);

        return {
          url: location.href,
          title: document.title,
          view,
          bootstrapped:
            Boolean(editor) &&
            Boolean(status) &&
            Boolean(document.querySelector('.views button[data-view]')) &&
            Boolean(document.querySelector('main#main')),
          navTabs,
          lab: {
            status: {
              state: status?.dataset.state ?? 'unknown',
              text: text(status, 160),
            },
            consoleOutput,
            consoleEntryCount: consoleEntries.length,
            error: {
              visible: errorbar ? !errorbar.hidden : false,
              text: text(errorbar, 500),
            },
            editor: {
              present: Boolean(editor),
              length: code.length,
              knownPracticeSignatures,
            },
            inputsLength: inputs?.value.length ?? 0,
            examples,
          },
          mission: {
            active: missionStrip ? !missionStrip.hidden : false,
            countText: text(document.querySelector('#misi-count'), 40),
            selected: selectedCard
              ? {
                  id: selectedCard.dataset.id ?? '',
                  title: text(selectedCard.querySelector('.mtitle'), 200),
                  state: text(selectedCard.querySelector('.mstate'), 40),
                  task: text(taskParagraph, 900),
                  hint: text(hint, 600),
                }
              : null,
            summary: summaryElement
              ? {
                  visible: summaryVisible,
                  ok: summaryElement.classList.contains('ok'),
                  text: text(summaryElement, 700),
                }
              : null,
            cards,
          },
        };
      },
      {
        signatures: practiceEntries.map((entry) => ({ id: entry.id, signature: entry.codeSignature })),
      },
    );

    const identity = await inspectIdentity(page);

    return {
      ...snapshot,
      identity,
      pageErrors: [...this.pageErrors],
    };
  }

  async fillConfiguredIdentity(expected: { name: string; className: string }): Promise<IdentityVerification> {
    await this.openView('misi');
    const result = await fillIdentity(this.requirePage(), expected);
    if (!result.verified) {
      throw new BrowserError(
        'IDENTITY_VERIFICATION_FAILED',
        `Identity was not verified after filling: ${result.problems.join(' ')}`,
      );
    }
    return result;
  }

  async verifyConfiguredIdentity(expected: { name: string; className: string }): Promise<IdentityVerification> {
    await this.openView('misi');
    return verifyIdentity(this.requirePage(), expected);
  }

  async runPractice(exampleId: PracticeExample['id']): Promise<PracticeRunEvidence> {
    const example = PRACTICE_EXAMPLES[exampleId];
    if (!example) {
      throw new BrowserError('INVALID_EXAMPLE', `Practice example "${String(exampleId)}" is not allowed.`);
    }

    const page = this.requireAlurPage();
    await this.openView('lab');

    const missionActive = await page.evaluate(() => {
      const strip = document.querySelector<HTMLElement>('#mission-strip');
      return strip ? !strip.hidden : false;
    });
    if (missionActive) {
      throw new BrowserError(
        'MISSION_ACTIVE',
        'A graded mission is currently open in the Lab. Refusing to load a practice example over it.',
      );
    }

    const option = page.locator(`#sel-example option[value=${JSON.stringify(example.id)}]`);
    if ((await option.count()) !== 1) {
      throw new BrowserError(
        'EXAMPLE_UNAVAILABLE',
        `The built-in "${example.title}" example is not available on the current ALUR page.`,
      );
    }

    const startedAt = new Date().toISOString();
    const started = Date.now();
    await page.selectOption('#sel-example', example.id);

    try {
      await page.waitForFunction(
        (signature) => document.querySelector<HTMLTextAreaElement>('#code')?.value.includes(signature) ?? false,
        example.codeSignature,
        { timeout: 8_000 },
      );
    } catch {
      throw new BrowserError(
        'EXAMPLE_NOT_LOADED',
        `Selecting the "${example.title}" example did not load its expected program text.`,
      );
    }

    await page.waitForFunction(
      ({ expectedInputs }) => document.querySelector<HTMLInputElement>('#inputs')?.value === expectedInputs,
      { expectedInputs: example.inputs },
      { timeout: 8_000 },
    ).catch(() => {
      throw new BrowserError(
        'EXAMPLE_INPUTS_MISMATCH',
        `The "${example.title}" example did not load its expected inputs.`,
      );
    });

    await page.locator('#btn-reset').click();
    await page.waitForFunction(
      () => ['idle', 'ready'].includes(document.querySelector<HTMLElement>('#status')?.dataset.state ?? ''),
      null,
      { timeout: 8_000 },
    );

    await page.selectOption('#speed', '3');
    await page.locator('#btn-run').click();

    let timedOut = false;
    try {
      await page.waitForFunction(
        () =>
          ['done', 'error', 'input'].includes(document.querySelector<HTMLElement>('#status')?.dataset.state ?? ''),
        null,
        { timeout: 30_000 },
      );
    } catch {
      timedOut = true;
    }

    const finishedAt = new Date().toISOString();
    const finished = Date.now();

    const evidence = await page.evaluate((signature) => {
      const text = (element: Element | null, max = 2_000): string =>
        (element?.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
      const status = document.querySelector<HTMLElement>('#status');
      const errorbar = document.querySelector<HTMLElement>('#errbar');
      const entries = Array.from(document.querySelectorAll<HTMLElement>('#console .o'));
      const selectedTab = document.querySelector<HTMLElement>('.views button[aria-selected="true"]');
      return {
        url: location.href,
        view: selectedTab?.dataset.view ?? 'unknown',
        status: {
          state: status?.dataset.state ?? 'unknown',
          text: text(status, 160),
        },
        consoleOutput: entries.slice(-50).map((entry) => text(entry, 300)),
        consoleEntryCount: entries.length,
        error: {
          visible: errorbar ? !errorbar.hidden : false,
          text: text(errorbar, 600),
        },
        inputsValue: document.querySelector<HTMLInputElement>('#inputs')?.value ?? '',
        codeSignatureMatched:
          document.querySelector<HTMLTextAreaElement>('#code')?.value.includes(signature) ?? false,
      };
    }, example.codeSignature);

    const codeSignatureMatched = await page
      .locator('#code')
      .inputValue()
      .then((code) => code.includes(example.codeSignature))
      .catch(() => false);

    return {
      exampleId: example.id,
      expectedInputs: example.inputs,
      expectedConsoleLines: example.expectedConsoleLines,
      startedAt,
      finishedAt,
      durationMs: finished - started,
      url: evidence.url,
      view: evidence.view,
      codeSignatureMatched: evidence.codeSignatureMatched || codeSignatureMatched,
      inputsValue: evidence.inputsValue,
      status: evidence.status,
      consoleOutput: evidence.consoleOutput,
      consoleEntryCount: evidence.consoleEntryCount,
      error: evidence.error,
      timedOut,
      pageErrors: [...this.pageErrors],
    };
  }

  async captureScreenshot(fullPage = true): Promise<ScreenshotResult> {
    const page = this.requireAlurPage();

    // Example-loading toasts last seven seconds. Prefer evidence without the
    // transient overlay, but never block evidence capture forever.
    await page
      .locator('#toast')
      .waitFor({ state: 'hidden', timeout: 8_000 })
      .catch(() => {});

    // Screenshot evidence is restricted to the Lab. This prevents a direct MCP
    // screenshot call from persisting the Misi identity form or a graded task.
    const viewState = await page.evaluate(() => {
      const selected = document.querySelector<HTMLElement>('.views button[aria-selected="true"]');
      const view = selected?.dataset.view ?? '';
      const section = view ? document.querySelector<HTMLElement>(`#view-${view}`) : null;
      const strip = document.querySelector<HTMLElement>('#mission-strip');
      return {
        view,
        sectionVisible: Boolean(section && !section.hidden),
        missionActive: strip ? !strip.hidden : false,
      };
    });
    if (viewState.view !== 'lab' || !viewState.sectionVisible) {
      throw new BrowserError(
        'SCREENSHOT_NOT_LAB',
        `Evidence screenshots are restricted to the Lab view (current view: "${viewState.view || 'unknown'}").`,
      );
    }
    if (viewState.missionActive) {
      throw new BrowserError(
        'MISSION_ACTIVE_SCREENSHOT',
        'A graded mission is open in the Lab; refusing to capture it as evidence.',
      );
    }

    let buffer: Buffer | null = null;
    let usedFullPage = fullPage;
    let fallbackReason: string | null = null;

    if (fullPage) {
      try {
        buffer = await page.screenshot({ fullPage: true, timeout: 45_000 });
      } catch (error) {
        fallbackReason = `Full-page screenshot failed: ${clip(error instanceof Error ? error.message : String(error), 300)}`;
      }
    }

    if (!buffer || buffer.length > MAX_SCREENSHOT_BYTES) {
      if (buffer && buffer.length > MAX_SCREENSHOT_BYTES) {
        fallbackReason = `Full-page screenshot exceeded ${MAX_SCREENSHOT_BYTES} bytes; used the viewport instead.`;
      }
      buffer = await page.screenshot({ fullPage: false, timeout: 30_000 });
      usedFullPage = false;
    }

    if (!isPng(buffer)) {
      throw new BrowserError('SCREENSHOT_INVALID', 'Playwright did not return a valid PNG screenshot.');
    }
    if (buffer.length > MAX_SCREENSHOT_BYTES) {
      throw new BrowserError('SCREENSHOT_TOO_LARGE', 'The viewport screenshot is still too large for MCP transport.');
    }

    const dimensions = pngDimensions(buffer);
    return {
      buffer,
      fullPage: usedFullPage,
      fallbackReason,
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
    };
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.launchedHeadless = null;
    if (!browser) return;
    await browser.close().catch(() => {});
  }

  private requirePage(): Page {
    if (!this.page) {
      throw new BrowserError('BROWSER_NOT_LAUNCHED', 'Firefox has not been launched yet.');
    }
    return this.page;
  }

  private requireAlurPage(): Page {
    const page = this.requirePage();
    if (!isAllowedAlurPage(page.url())) {
      throw new BrowserError('UNEXPECTED_PAGE', `Current page is outside ALUR: ${clip(page.url(), 300)}`);
    }
    return page;
  }
}

export { safePageText };
