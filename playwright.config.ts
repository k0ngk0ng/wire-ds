import { defineConfig } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

process.env.electron_config_cache = path.join(__dirname, '.cache/electron');
process.env.TMPDIR = path.join(__dirname, '.cache/tmp');
fs.mkdirSync(process.env.TMPDIR, { recursive: true });

export default defineConfig({
  testDir: './tests',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }], ['json', { outputFile: 'artifacts/e2e-results.json' }]],
  outputDir: 'test-results',
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
