import { defineConfig } from '@playwright/test';
import config from './playwright.config';

export default defineConfig({ ...config, testMatch: '**/install.e2e.ts', timeout: 120_000, outputDir: 'test-results/install', reporter: [['list'], ['html', { outputFolder: 'artifacts/install-report', open: 'never' }], ['json', { outputFile: 'artifacts/install-results.json' }]] });
