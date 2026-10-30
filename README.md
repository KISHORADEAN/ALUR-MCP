# ALUR Agent

A local-first, approval-gated Firefox assistant for the official
[ALUR Lab Maya Pseudocode](https://ramli-labs.github.io/ALUR/) site.

ALUR Agent fills the operator-configured `Nama` and `Kelas` fields, runs **one
built-in, ungraded practice example**, and only reports `VERIFIED` when the
page itself proves that the exact example completed. It does not solve, attempt,
or submit graded missions.

> Status: working MVP, verified on macOS against the live ALUR site on
> 2026-10-29. The OpenRouter advisory path is implemented but a live AI request
> has not been executed because no API key was available. See
> [Verified and unverified](#verified-and-unverified).

## What it does

- Launches Playwright **Firefox** and refuses to continue with any other
  browser engine.
- Opens only the hard-coded official ALUR URL.
- Inspects the page read-only and fails preflight if the expected UI, identity
  fields, or practice examples are missing.
- Shows two explicit approval gates: one before filling identity and one before
  running the practice example.
- Fills only the `Nama` (`#who-name`) and `Kelas` (`#who-class`) inputs, then
  re-verifies both the inputs and ALUR's `localStorage` values.
- Runs one allowlisted demo (`faktorial` or `rata`) without editing its source.
- Verifies completion from bound page evidence, not from a status badge or AI
  text.
- Saves a Lab-only PNG, a JSON sidecar, and a sanitized JSON report with mode
  `0600`.
- Writes sanitized JSONL logs.

## What it does not do

- No graded missions, quizzes, trace tables, LKPD tasks, or submissions.
- No CAPTCHA, authentication, or anti-bot bypass.
- No arbitrary URLs, shell access, filesystem tools, or mission tools exposed
  through MCP.
- No Chromium/WebKit fallback and no executable-path override.
- No claim of completion based on AI output, a stale `done` badge, or a
  screenshot alone.
- No automatic retry of a failed completion to make it look successful.

## Architecture

```text
CLI (src/index.ts)
  ├─ config.ts            validated, official-URL-only configuration
  ├─ logger.ts            JSONL logs with redaction and action timing
  ├─ approvals.ts         two human approval gates; safe non-interactive denial
  ├─ agent.ts             OpenRouter advisory only (cannot act or verify)
  └─ workflow.ts          deterministic orchestration and exit codes
       ├─ AlurMcpClient   stdio MCP client, exact tool catalog, schema checks
       │    └─ Custom MCP server (mcp-server.ts)
       │         └─ FirefoxBrowser (Playwright Firefox)
       │              └─ ALUR page (fixed origin/path)
       ├─ completion.ts   strict practice/mission completion evaluators
       └─ screenshot.ts   PNG/sidecar/report allocation and sanitization
```

The AI is advisory only. It may call `get_page_state` and `propose_action`
inside its own bounded loop, but it has no browser tools. The workflow never
executes an AI-proposed action automatically; a human approves each mutation,
and the deterministic verifier alone decides the final state.

## Requirements

- Node.js 20 or newer (verified with Node 25.9.0)
- npm
- macOS, Linux, or Windows (only macOS was verified for this build)
- Network access to `https://ramli-labs.github.io/ALUR/`
- Playwright Firefox

Key dependency versions in this build:

| Package | Version |
| --- | --- |
| Playwright | 1.64.1 |
| Playwright Firefox | 157.0 |
| `@modelcontextprotocol/server` | 2.4.0 |
| `@modelcontextprotocol/client` | 2.4.0 |
| OpenAI SDK (OpenRouter-compatible) | 7.45.1 |
| TypeScript | 7.0.2 |
| Vitest | 4.1.12 |

## Install

```bash
npm install
npx playwright install firefox
cp .env.example .env
```

Edit `.env` locally. At minimum, set your own identity values:

```dotenv
STUDENT_NAME=Your Name
STUDENT_CLASS=Your Class
OPENROUTER_API_KEY=sk-or-v1-...
```

`OPENROUTER_API_KEY` is required for the default `start` command. To run the
deterministic path without AI, pass `--no-ai` and leave the key blank.

The following are optional (defaults shown):

```dotenv
OPENROUTER_MODEL=openrouter/free
ALUR_URL=https://ramli-labs.github.io/ALUR/
HEADLESS=false
MAX_AGENT_STEPS=10
OPENROUTER_TIMEOUT_MS=45000
ALUR_PRACTICE_EXAMPLE=faktorial
ALUR_EVIDENCE_DIR=evidence
ALUR_LOG_DIR=logs
```

`.env` is ignored by Git. Never commit it.

Environment loading is centralized: the CLI and smoke scripts load the
repository-root `.env` (not the shell's working directory). Existing non-empty
shell environment variables win; empty or whitespace-only values count as
unconfigured, and an exported-empty key does not shadow a real `.env` value.
Check the effective state without printing the secret:

```bash
npm run env:check
```

OpenRouter smoke checks are separate on purpose:

```bash
npm run smoke:openrouter   # GET /api/v1/models only
npm run smoke:chat         # POST /api/v1/chat/completions, requires a real key
```

`smoke:openrouter` succeeding does not prove chat completion works.
`smoke:chat` reports PASS only when HTTP 200 includes non-empty answer text.
Both commands print `UNVERIFIED` and exit 0 when no key is configured; they
never print the key, Authorization header, or raw response bodies.

## Commands

```bash
# Read-only page inspection (no identity required)
npm run inspect -- --headless
# Use --silent to keep npm's script banner out of the JSON stream
npm --silent run inspect -- --headless --json

# Read-only preflight: launch, open, inspect, close
npm run dry-run -- --headless

# Default: fill identity, then run faktorial after two approvals
npm run start -- --headless

# Explicitly pre-approve both gates (only for a trusted local run)
npm run start -- --headless --yes

# Deterministic run without OpenRouter
npm run start -- --headless --yes --no-ai

# Run the other allowlisted example
npm run start -- --headless --yes --no-ai --example rata

# Development checks
npm run typecheck
npm test
npm run test:integration
npm run build

# Run the constrained MCP server directly on stdio
npm run mcp
```

CLI options:

| Option | Meaning |
| --- | --- |
| `-y`, `--yes` | Explicitly pre-approve both mutating gates |
| `--no-ai` | Skip OpenRouter entirely |
| `--headless` / `--headed` | Firefox window mode (default headed) |
| `--example faktorial\|rata` | Select the built-in ungraded example |
| `--json` | Machine-readable output for `inspect` |
| `-h`, `--help` | Usage and safety notes |

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | `VERIFIED` |
| `1` | `NOT_COMPLETED` |
| `2` | `ABORTED` or `UNKNOWN` |
| `3` | `FAILED`, configuration error, MCP error, or startup failure |

## Approval and run flow

1. Launch Firefox and verify the engine is Firefox.
2. Open the official ALUR URL and inspect the page.
3. Fail preflight if the page is not ALUR, the app is not bootstrapped, a
   graded mission is active, identity fields are missing/ambiguous, the chosen
   example is unavailable, or page JavaScript errors were observed.
4. Optionally ask OpenRouter for a short advisory. This cannot block a run
   unless `requireAi` is true and the advisory fails.
5. **Approval gate 1:** fill the configured `Nama` and `Kelas`.
6. Fill and verify the inputs and `localStorage`; re-open and verify again.
7. **Approval gate 2:** run the chosen built-in example unchanged.
8. Load the example, verify its source signature and inputs, reset state, then
   run it at instant speed.
9. Evaluate completion strictly.
10. Switch to Lab, wait up to 8 seconds for transient toasts to clear, and
    capture a Lab-only screenshot.
11. Save the sidecar and sanitized report, close Firefox, and return an exit
    code.

Without `--yes`, a non-interactive terminal is treated as a denial. There is no
"default yes".

## Completion verification

A `done` badge is not enough. ALUR may already show a `done` state from its
default example before the agent runs. For a practice example, `VERIFIED`
requires all of the following in one evidence bundle:

- The evidence URL is the official ALUR origin and path.
- The active view is Lab.
- The run reached a terminal state before the timeout.
- No visible error bar and no `error` status.
- The status is `done`.
- No page JavaScript errors.
- The editor still contains the exact allowlisted source signature.
- The loaded inputs exactly match the allowlist.
- The expected evidence bundle exactly matches the allowlist.
- Every expected console line is present.
- Exactly one fresh `Program selesai dalam N langkah.` line exists.
- The start/finish timestamps are valid and ordered.

Missing or ambiguous evidence yields `UNKNOWN`, never `VERIFIED`. `FAILED`
indicates an ALUR error or non-official evidence. `NOT_COMPLETED` indicates the
run reached a terminal state without the expected completion.

`evaluateMissionCompletion` exists and is unit-tested, but no mission automation
is wired to it. It requires ALUR's stored mission state to be `done` together
with a matching selected mission, passing card, and visible summary. The agent
does not expose mission tools or attempt graded work.

## MCP server and Firefox compatibility

The project uses a **custom least-privilege MCP server** (`src/mcp-server.ts`)
rather than the upstream Playwright MCP. The upstream project documents Firefox
via `--browser firefox`
([README](https://github.com/microsoft/playwright-mcp)), but its broad browser
tool surface is not a suitable safety boundary for this task. The custom server
exposes exactly nine fixed tools:

| Tool | Purpose |
| --- | --- |
| `firefox_launch` | Launch Playwright Firefox; no engine or executable override |
| `alur_open` | Open the hard-coded official URL; no URL argument |
| `alur_inspect` | Read a sanitized snapshot without typed identity values |
| `alur_open_view` | Switch to one of the five fixed ALUR tabs |
| `alur_fill_identity` | Fill only `Nama` and `Kelas`, then verify |
| `alur_verify_identity` | Re-read fields/storage without returning values |
| `alur_run_practice` | Run one allowlisted ungraded example |
| `alur_screenshot` | Capture a PNG, restricted to the Lab view |
| `firefox_close` | Close the isolated browser |

The client rejects a server whose tool catalog differs from that exact list,
validates tool result schemas, bounds requests with timeouts, validates PNG
bytes and metadata, and does not forward `OPENROUTER_API_KEY` to the server
process.

Firefox-specific checks and workarounds:

- `firefox.launch()` is used directly; after launch the engine name is checked
  and any non-Firefox engine is rejected.
- No `channel`, `executablePath`, or Chromium fallback exists.
- `serviceWorkers` are blocked.
- Popups are closed and dialogs dismissed.
- A harmless page-world `__name` shim is installed before ALUR scripts run,
  because `tsx`/esbuild can inject that helper into serialized callbacks.
- A missing Firefox install produces a clear error asking the operator to run
  `npx playwright install firefox`.

## Evidence and privacy

A successful run writes:

```text
evidence/YYYY-MM-DD/task-NNN.png           full-page Lab screenshot, mode 0600
evidence/YYYY-MM-DD/task-NNN.json          screenshot sidecar, mode 0600
evidence/YYYY-MM-DD/task-NNN.report.json   sanitized run report, mode 0600
logs/alur-YYYY-MM-DD.jsonl                 sanitized JSONL log
```

The screenshot is taken only after switching to Lab and only when no graded
mission is active. The sidecar records the URL, run id, completion state,
practice id/title, image dimensions, SHA-256, and fallback status. It does not
contain the name, class, or API key. Reports contain masked/no identity values,
the completion signals, AI advisory status, action timings, and warnings.

Logging redacts known secret keys and bearer/API-key patterns. Tool inputs are
not logged, and identity values are never returned by MCP tools. The final live
runs were checked for the configured name, class, and API-key patterns in
evidence and logs.

Screenshots are visual evidence. Review them before sharing, because the page
itself may contain content you consider personal.

## AI advisory

`src/agent.ts` uses the OpenAI-compatible SDK with
`baseURL: https://openrouter.ai/api/v1`. It:

- Looks up the configured model in OpenRouter's public model list.
- Uses tool calling only when the model advertises `tools`; otherwise it makes
  a plain advisory request.
- Exposes only `get_page_state` and `propose_action` to the model.
- Treats all page text as untrusted data and ignores prompt-injection attempts.
- Bounds the tool loop with `MAX_AGENT_STEPS`, request timeouts, retries, and
  output redaction/truncation.
- Never treats AI text as completion evidence.

`openrouter/free` advertised `tools` in its public metadata during this build,
but **no live chat completion or tool call was executed** because no API key was
configured. The `--no-ai` path is fully deterministic and was verified live.

## Verified and unverified

Verified live on macOS on 2026-10-29:

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm test` | 38 passed, 1 skipped (live test skipped by default) |
| `npm run test:integration` | 1 live test passed (10.45 s) |
| `npm run build` | Passed |
| `npm --silent run inspect -- --headless --json` | Passed against live ALUR |
| `npm run dry-run -- --headless` | All preflight checks passed; no mutations |
| `npm run start -- --headless --yes --no-ai` | `VERIFIED`; `task-002` PNG/sidecar/report |
| `npm run start -- --headless --yes --no-ai --example rata` | `VERIFIED`; `task-003` PNG/sidecar/report |
| Screenshot content | Lab only, no toast, no identity fields |
| Evidence/log privacy check | No configured name, class, or key pattern found |
| Firefox engine guard | Live runs used Playwright Firefox |
| Constrained MCP catalog | Nine tools; exact catalog enforced by the client |

Not verified or intentionally out of scope:

| Item | Status |
| --- | --- |
| Live OpenRouter chat/tool-call advisory | Blocked: no `OPENROUTER_API_KEY` available |
| Interactive TTY approval prompt (`yes` typed by a human) | Approval logic and non-interactive denial tested; prompt not exercised end-to-end |
| Headed visual runs | Final live verification used `--headless` |
| Windows/Linux | Not tested |
| Screenshot viewport fallback | Full-page path worked; fallback not exercised live |
| Graded mission automation | Intentionally not implemented |
| CAPTCHA/auth bypass | Intentionally not implemented |
| Upstream Playwright MCP | Not used or tested in this build; custom server selected |

## Project layout

```text
src/
  agent.ts       OpenRouter advisory client
  approvals.ts   interactive/flag approval gate
  browser.ts     Playwright Firefox lifecycle and ALUR actions
  completion.ts  strict practice/mission completion evaluation
  config.ts      environment validation and safe configuration summary
  identity.ts    label-based identity field discovery/fill/verify
  index.ts       CLI entry point and command dispatch
  logger.ts      sanitized JSONL logging and action records
  mcp-client.ts  stdio client, strict catalog/schema/PNG validation
  mcp-server.ts  constrained nine-tool MCP server
  redact.ts      redaction, clipping, masking, error sanitization
  screenshot.ts  evidence allocation, sidecars, sanitized reports
  site.ts        official URL, views, allowlisted examples, identity keys
  types.ts       shared evidence and report types
  workflow.ts    deterministic approval-gated orchestration
tests/
  config.test.ts
  completion.test.ts
  workflow.test.ts
  integration/alur-mcp.integration.test.ts
```

## Troubleshooting

**`Playwright could not launch Firefox`**  
Run `npx playwright install firefox` and retry.

**`Invalid configuration`**  
Copy `.env.example` to `.env`, fill in `STUDENT_NAME`, `STUDENT_CLASS`, and (for
AI mode) `OPENROUTER_API_KEY`. Use `--no-ai` to skip the key requirement.

**`No interactive terminal is available`**  
Run from a terminal and type `yes` at each gate, or pass `--yes` explicitly.

**`PREFLIGHT_FAILED`**  
The ALUR page changed, a graded mission is open in the Lab, or identity fields
could not be identified unambiguously. Run `npm run inspect` and review the
sanitized output. The agent fails closed rather than guessing.

**`UNKNOWN` completion**  
The page could not prove the exact allowlisted task completed. Review the
report's `completion.reasons`, the sidecar, and the JSONL log. Do not treat this
as success.

**The site's selectors change**  
Selectors and example signatures in `src/site.ts` and `src/browser.ts` were
verified against the live site on 2026-10-29. A site update may require
re-verification; the preflight checks are designed to fail closed.

## Safety notes

This is an educational, local-first tool. It is not affiliated with ALUR or its
authors. Use it only with your own identity and only for the built-in ungraded
practice examples. The agent deliberately leaves graded assessments to the
human and never submits work. Review the code and the saved evidence before
sharing results.
