ALUR MCP — Environment & OpenRouter Validation Report (2026-10-30)

1. ROOT CAUSE (confirmed from files)
- The repository-root `.env` currently contains `OPENROUTER_API_KEY=` with a **zero-length value**. `OPENROUTER_API_KEY` is also absent from the shell environment.
- Therefore `dotenv` correctly loads an empty string, and every check treats it as unconfigured: `Key available: false`, `Key length: 0`, `UNVERIFIED: API key not readable`.
- File inspection ruled out encoding/format causes: no BOM, LF-only, 8 lines, key assignment present.
- A previous `.env` had duplicate assignments (e.g. two `STUDENT_NAME` lines), which made edits appear inconsistent; it has been cleaned to one assignment per key.
- Loading was not the root cause of the chat test, but it was inconsistent: the old smoke snippet resolved `.env` from the shell's working directory. It now resolves from the repository root.

Hypotheses not confirmed:
- A real key may have been typed into a different file (`.env.example`, another checkout) or not saved.
- If a shell exported an empty `OPENROUTER_API_KEY`, it could previously shadow `.env`; this is now handled by deleting empty/whitespace-only values before dotenv loads.

2. FILES CHANGED
- `src/env.ts` (new): single project env loader; resolves repository-root `.env` (or an explicit cwd with `.env`), preserves non-empty shell values, treats empty/whitespace as unset.
- `src/config.ts`, `src/index.ts`: use `loadProjectEnv()` instead of ad-hoc `dotenv.config()`.
- `scripts/env.js` (new): same root-resolution rules for scripts.
- `scripts/openrouter-smoke-lib.js` (new): testable `checkModels` / `checkChat`; trims keys; safe error text; no secret output.
- `scripts/smoke-openrouter.js`: now checks `/models` only and explicitly says so.
- `scripts/smoke-chat.js` (new): checks `POST /chat/completions`; PASS only for HTTP 200 with non-empty answer text.
- `scripts/check-env.js` (new): `npm run env:check`, reports presence/length/source without printing values.
- `package.json`: scripts `env:check`, `smoke:openrouter`, `smoke:chat`.
- `tests/openrouter-smoke.test.ts` (new): 16 mocked tests.
- `tests/env-config.test.ts`: `.env` loading, whitespace-only keys, empty-shell shadowing.
- `README.md`: `.env` and smoke-test guidance.
- No browser workflow, approval boundary, evidence, or logs were modified.

3. TEST RESULTS (executed)
- `npm test`: **66 passed | 1 skipped | 0 failed** (7 passed files, 1 skipped live integration).
- `npm run typecheck`: PASS.
- `npm run build`: PASS.
- `npm run env:check`: `.env` exists, assignment line present, value length 0, effective key configured: no → `UNVERIFIED`.
- `npm run smoke:openrouter`: `UNVERIFIED` (no key configured); no network request.
- `npm run smoke:chat`: `UNVERIFIED` (no key configured); no network request.
- Mocked coverage: missing/empty/whitespace keys, HTTP 401/402/429/5xx, malformed JSON, missing/empty answer text, timeouts, network failures, and no secret leakage.

4. LIVE RESULTS (separate)
- Live `/models`: **UNVERIFIED** for the current environment (no real key). An earlier synthetic-key run returned HTTP 200 with 457 models, but that is not a valid credential verification.
- Live chat completion: **UNVERIFIED**. No real key is configured; `smoke:chat` made no request.
- Do not treat `/models` success as chat-completion success.

5. SECURITY / GIT
- `.env` is not tracked; `.gitignore` covers it.
- `.env.example` contains placeholders only.
- Smoke scripts never print key, Authorization header, or raw response bodies.
- `git status` shows only intended source/test/doc changes. No commit, push, or history rewrite performed.

6. NEXT COMMANDS
- `npm run env:check` — verify the effective key state without printing it.
- Put a real key on the single `OPENROUTER_API_KEY=` line in the repository-root `.env` (or export a non-empty shell value), then:
  - `npm run smoke:openrouter`
  - `npm run smoke:chat`
- Optional Firefox check: `npm run dry-run -- --headless`, then `npm run start -- --yes --headless --example faktorial --no-ai`.
- If the key still reads as absent after editing, run `npm run env:check` and confirm `.env` path and `value length in .env`.
