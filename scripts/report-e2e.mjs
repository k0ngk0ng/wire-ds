import { readFile, appendFile } from 'node:fs/promises';

const file = process.argv[2] || 'artifacts/e2e-results.json';
let report;
try { report = JSON.parse(await readFile(file, 'utf8')); }
catch { console.log(`No E2E report generated: ${file}`); process.exit(0); }
const lines = [`## ${file}`, '', `Passed: ${report.stats.expected}; failed: ${report.stats.unexpected}; skipped: ${report.stats.skipped}`, ''];
function visit(suites) {
  for (const suite of suites || []) {
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) {
        for (const result of test.results || []) {
          if (['passed', 'skipped'].includes(result.status)) continue;
          const message = (result.errors || []).map(error => error.message || error.stack || '').join('\n').replace(/\u001b\[[0-9;]*m/g, '');
          const fence = '`'.repeat(Math.max(3, ...[...message.matchAll(/`+/g)].map(match => match[0].length + 1)));
          lines.push(`### ${spec.title} (${result.status})`, '', fence, message, fence, '');
        }
      }
    }
    visit(suite.suites);
  }
}
visit(report.suites);
const output = lines.join('\n');
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, output + '\n');
else console.log(output);
