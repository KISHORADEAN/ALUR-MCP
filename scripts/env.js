#!/usr/bin/env node
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..');
export const ENV_PATH = path.join(REPO_ROOT, '.env');

/**
 * Load the repository-root .env without overriding explicitly supplied shell
 * environment variables. Whitespace-only values are treated as unset.
 */
export function loadRepoEnv() {
  if (fs.existsSync(ENV_PATH)) {
    // An exported-but-empty key must not shadow a real .env value.
    if (typeof process.env.OPENROUTER_API_KEY === 'string' && process.env.OPENROUTER_API_KEY.trim() === '') {
      delete process.env.OPENROUTER_API_KEY;
    }
    dotenv.config({ path: ENV_PATH, override: false, quiet: true });
  }
  return REPO_ROOT;
}

export function getOpenRouterApiKey() {
  const raw = process.env.OPENROUTER_API_KEY;
  return typeof raw === 'string' ? raw.trim() : '';
}

export function openRouterKeyConfigured() {
  return getOpenRouterApiKey().length > 0;
}
