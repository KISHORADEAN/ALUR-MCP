#!/usr/bin/env node
import fs from 'node:fs';
import { ENV_PATH, REPO_ROOT, getOpenRouterApiKey, loadRepoEnv } from './env.js';

const rawShell = process.env.OPENROUTER_API_KEY;
const shellKey = typeof rawShell === 'string' ? rawShell.trim() : '';

loadRepoEnv();

const exists = fs.existsSync(ENV_PATH);
const effectiveKey = getOpenRouterApiKey();

console.log('OpenRouter environment check');
console.log(`  project root: ${REPO_ROOT}`);
console.log(`  .env path: ${ENV_PATH}`);
console.log(`  .env exists: ${exists ? 'yes' : 'no'}`);

if (exists) {
  const text = fs.readFileSync(ENV_PATH, 'utf8');
  const line = text.split(/\r?\n/).find((entry) => entry.trimStart().startsWith('OPENROUTER_API_KEY')) ?? '';
  const rawValue = line.includes('=') ? line.slice(line.indexOf('=') + 1) : '';
  console.log(`  key assignment line present: ${line ? 'yes' : 'no'}`);
  console.log(`  value length in .env: ${rawValue.trim().length}`);
}

console.log(`  key present in shell env: ${shellKey.length > 0 ? 'yes' : 'no'}`);
console.log(`  effective key configured: ${effectiveKey.length > 0 ? 'yes' : 'no'}`);
console.log(`  effective key length: ${effectiveKey.length}`);
console.log('  values are never printed; empty/whitespace-only counts as unconfigured.');

if (!effectiveKey) {
  console.log('RESULT: UNVERIFIED (OPENROUTER_API_KEY is empty or missing)');
}
