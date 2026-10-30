#!/usr/bin/env node
import { getOpenRouterApiKey, loadRepoEnv } from './env.js';
import { checkChat } from './openrouter-smoke-lib.js';

loadRepoEnv();

const model = process.env.OPENROUTER_MODEL?.trim() || 'openrouter/free';
console.log(`LIVE CHAT SMOKE: POST /chat/completions with model=${model}`);
const result = await checkChat({ apiKey: getOpenRouterApiKey(), model });

if (result.status === 'UNVERIFIED') {
  console.log(`UNVERIFIED: ${result.reason}`);
  process.exit(0);
}
if (result.status === 'FAIL') {
  console.log(`FAIL: ${result.reason}`);
  process.exit(1);
}
console.log(`PASS: OpenRouter chat completion returned non-empty text (model=${result.model}, characters=${result.characters}).`);
