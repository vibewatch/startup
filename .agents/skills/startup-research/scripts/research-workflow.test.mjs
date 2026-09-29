import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';

function workflowSteps(file) {
  const workflow = yaml.load(readFileSync(`.github/workflows/${file}`, 'utf8'));
  return Object.values(workflow.jobs).flatMap(job => job.steps ?? []);
}

for (const file of ['company.yml', 'refresh-company.yml', 'research-unicorns.yml']) {
  test(`authenticated research pipeline is workflow-owned: ${file}`, () => {
    const step = workflowSteps(file).find(entry =>
      /^\s*npm run research:workers --/mu.test(entry.run ?? '')
      && /^\s*(?:if )?npm run research:finalize --/mu.test(entry.run ?? ''));
    assert.ok(step, 'Workers and finalizers must run in the workflow shell, not a parent model tool');
    assert.equal(step.env.COPILOT_GITHUB_TOKEN, '${{ secrets.COPILOT_PAT }}');
    assert.equal(step.env.STARTUP_FETCH_LOG_PATH, '${{ github.workspace }}/.research-cache/_fetch-log.jsonl');
    assert.doesNotMatch(step.run, /copilot --/u);
    assert.doesNotMatch(step.run, /--skip|--disable-escalation/u);
  });
}

for (const failure of ['none', 'auto-target', 'create', 'bootstrap', 'workers', 'finalizer', 'authentication']) {
  test(`refresh orchestration preserves context and failure gates: ${failure}`, () => {
    const step = workflowSteps('refresh-company.yml').find(entry => entry.name === 'Generate refreshed diligence report');
    const root = mkdtempSync(join(tmpdir(), 'refresh-auth-test-'));
    const callsPath = join(root, 'calls.jsonl');
    const runId = '20990101000000-fixture';
    const reason = 'Reconcile $3.5B and $6.9B; preserve source attribution.';
    const website = failure === 'auto-target' ? '' : 'https://example.org/?first=1&second=2';
    const priorRun = failure === 'auto-target' ? '' : '20260923052317-groq';
    const profile = failure === 'auto-target' ? 'deep' : 'fast';
    try {
      mkdirSync(join(root, 'bin'));
      mkdirSync(join(root, 'runner-temp'));
      writeFileSync(callsPath, '');
      const mock = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify({ command, args, authenticated: Boolean(process.env.COPILOT_GITHUB_TOKEN) }) + '\\n');
if (command === 'copilot') process.exit(97);
if (command === 'node') {
  if (process.env.FAILURE === 'create') process.exit(4);
  process.stdout.write('reports/${runId}\\n');
  process.exit(0);
}
const phase = args[1];
if (phase === 'research:bootstrap' && process.env.FAILURE === 'bootstrap') process.exit(1);
if (phase === 'research:workers' && process.env.FAILURE === 'workers') process.exit(1);
if (phase === 'research:finalize' && process.env.FAILURE === 'finalizer') process.exit(1);
`;
      for (const name of ['node', 'npm', 'copilot']) {
        const file = join(root, 'bin', name);
        writeFileSync(file, mock);
        chmodSync(file, 0o755);
      }
      const result = spawnSync('bash', ['-c', step.run], {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${join(root, 'bin')}:${process.env.PATH}`,
          CALLS: callsPath,
          FAILURE: failure,
          COPILOT_GITHUB_TOKEN: failure === 'authentication' ? '' : 'fixture-only-token',
          COMPANY: 'Groq Fixture',
          COMPANY_URL: website,
          REFRESH_REASON: reason,
          REFRESH_OF: priorRun,
          PROFILE: profile,
          RUNNER_TEMP: join(root, 'runner-temp'),
          GITHUB_STEP_SUMMARY: join(root, 'runner-temp', 'summary.txt'),
          STARTUP_FETCH_LOG_PATH: join(root, '.research-cache', '_fetch-log.jsonl'),
        },
        encoding: 'utf8',
      });
      const calls = readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      if (failure === 'authentication') {
        assert.notEqual(result.status, 0);
        assert.deepEqual(calls, [], 'Missing credentials must fail before creating or researching a report');
        assert.match(result.stderr, /COPILOT_PAT/u);
        return;
      }
      assert.deepEqual(calls[0], {
        command: 'node',
        args: [
          '.agents/skills/startup-research/scripts/create-report-run.mjs',
          'Groq Fixture', '--refresh', '--refresh-reason', reason,
          ...(website ? ['--website', website] : []),
          ...(priorRun ? ['--refresh-of', priorRun] : []),
        ],
        authenticated: true,
      });
      assert.ok(calls.every(call => call.authenticated));
      assert.equal(calls.some(call => call.command === 'copilot'), false);
      const expected = failure === 'create' ? []
        : failure === 'bootstrap' ? ['research:profile', 'research:bootstrap']
          : ['research:profile', 'research:bootstrap', 'research:workers', 'research:finalize'];
      assert.deepEqual(calls.slice(1).map(call => call.args[1]), expected);
      for (const call of calls.slice(1)) {
        assert.equal(call.args[call.args.indexOf('--report-folder') + 1], `reports/${runId}`);
      }
      if (failure === 'none' || failure === 'auto-target' || failure === 'workers') {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(readFileSync(join(root, 'runner-temp', 'report-folder.txt'), 'utf8'), `reports/${runId}\n`);
        assert.deepEqual(calls.slice(1).map(call => call.args), [
          ['run', 'research:profile', '--', '--report-folder', `reports/${runId}`, '--profile', profile],
          ['run', 'research:bootstrap', '--', '--report-folder', `reports/${runId}`, '--company', 'Groq Fixture', '--profile', profile, ...(website ? ['--website', website] : [])],
          ['run', 'research:workers', '--', '--report-folder', `reports/${runId}`, '--concurrency', '8', '--timeout-seconds', '900'],
          ['run', 'research:finalize', '--', '--report-folder', `reports/${runId}`, '--timeout-seconds', '900'],
        ]);
      } else {
        assert.notEqual(result.status, 0);
      }
      if (failure === 'create') assert.equal(existsSync(join(root, 'runner-temp', 'report-folder.txt')), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
