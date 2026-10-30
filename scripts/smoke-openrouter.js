#!/usr/bin/env node
import { getOpenRouterApiKey, loadRepoEnv } from './env.js';
import { checkModels } from './openrouter-smoke-lib.js';

loadRepoEnv();

console.log('LIVE SMOKE: checking OpenRouter /models endpoint');
const result = await checkModels({ apiKey: getOpenRouterApiKey() });

if (result.status === 'UNVERIFIED') {
  console.log(`UNVERIFIED: ${result.reason}`);
  process.exit(0);
}
if (result.status === 'FAIL') {
  console.log(`FAIL: ${result.reason}`);
  process.exit(1);
}
console.log(`PASS: OpenRouter /models reachable and valid (models=${result.models}).`);
console.log('NOTE: This only verifies /models, not chat completion. Run npm run smoke:chat for that.');
