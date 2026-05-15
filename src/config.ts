import 'dotenv/config';
import type { Config } from './types.js';

export function loadConfig(): Config {
  const model = process.env.REIKA_MODEL;
  if (!model) {
    throw new Error('REIKA_MODEL is required. Copy .env.example to .env and set it.');
  }
  return {
    baseURL: process.env.REIKA_BASE_URL ?? 'http://localhost:11434/v1',
    apiKey: process.env.REIKA_API_KEY ?? 'no-key',
    model,
    maxTurns: parseInt(process.env.REIKA_MAX_TURNS ?? '12', 10),
    repoMapBudget: parseInt(process.env.REIKA_REPO_MAP_BUDGET ?? '3200', 10),
    autoApprove: process.env.REIKA_AUTO_APPROVE === 'true' || process.env.REIKA_AUTO_APPROVE === '1',
  };
}
