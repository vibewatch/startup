#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const runId = `20990101000000-worker-check-${process.pid}`;
const folder = resolve('.research-cache', runId);
const bundlePath = join(folder, 'search-bundle.json');

function run(script, args) {
  const result = spawnSync(process.execPath, [join(here, script), ...args], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `${script} exited ${result.status}`);
  }
  return result.stdout;
}

try {
  mkdirSync(folder, { recursive: true });
  run('apply-research-profile.mjs', [
    '--report-folder', folder,
    '--profile', 'fast',
  ]);
  const roster = JSON.parse(run('load-chapter-runtime-context.mjs', [
    '--list',
    '--report-folder', folder,
  ]));
  writeFileSync(bundlePath, `${JSON.stringify({
    schemaVersion: 'search-bundle-v1',
    chapterPools: roster.chapters.map((chapter) => ({
      key: chapter.key,
      recommended: [],
      reserve: [],
    })),
    fetchedSources: [],
  }, null, 2)}\n`);
  const plan = JSON.parse(run('run-chapter-workers.mjs', [
    '--report-folder', folder,
    '--dry-run',
    '--format', 'json',
  ]));
  writeFileSync(join(folder, 'worker-results.json'), `${JSON.stringify({
    schemaVersion: 'chapter-worker-run-v1',
    workers: [],
    validations: [],
    ok: true,
  }, null, 2)}\n`);
  const finalizer = JSON.parse(run('run-report-finalizer.mjs', [
    '--report-folder', folder,
    '--dry-run',
    '--format', 'json',
  ]));
  const fakeCopilotPath = join(folder, 'fake-copilot.mjs');
  const fakeCopilotLogPath = join(folder, 'fake-copilot.log');
  writeFileSync(join(folder, '_fetch-log.jsonl'), '{}\n');
  writeFileSync(fakeCopilotPath, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.FAKE_COPILOT_LOG, \`\${JSON.stringify(process.argv.slice(2))}\\n\`);
process.exit(1);
`);
  chmodSync(fakeCopilotPath, 0o755);
  const fallbackProbe = spawnSync(process.execPath, [
    join(here, 'run-report-finalizer.mjs'),
    '--report-folder', folder,
    '--timeout-seconds', '60',
    '--copilot-bin', fakeCopilotPath,
    '--format', 'json',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FAKE_COPILOT_LOG: fakeCopilotLogPath,
      STARTUP_FETCH_LOG_PATH: join(folder, '_fetch-log.jsonl'),
    },
  });
  const fallbackInvocations = readFileSync(fakeCopilotLogPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const companyWorkflow = readFileSync(resolve('.github/workflows/company.yml'), 'utf8');
  const checks = [
    [plan.runId === basename(folder), 'runner emitted the wrong runId'],
    [plan.concurrency === 8, 'runner default concurrency is not 8'],
    [plan.timeoutSeconds === 900, 'runner default timeout is not 900 seconds'],
    [plan.workers.length === roster.totalChapters, 'runner did not schedule every chapter'],
    [plan.workers.every((worker) => worker.model === 'gpt-5.4-mini'), 'runner did not use Mini'],
    [plan.workers.every((worker) => worker.reasoningEffort === 'medium'), 'runner did not use Mini medium effort'],
    [plan.workers.every((worker) => worker.escalateTo === 'gpt-5.6-sol-fast'), 'runner did not retain the Sol Fast quality fallback'],
    [finalizer.model === 'gpt-5.4-mini', 'finalizer did not use Mini'],
    [finalizer.reasoningEffort === 'medium', 'finalizer did not use Mini medium effort'],
    [finalizer.escalateTo === 'gpt-5.6-sol-fast', 'finalizer did not retain the Sol Fast quality fallback'],
    [finalizer.escalationReasoningEffort === 'xhigh', 'finalizer escalation effort is not xhigh'],
    [finalizer.timeoutSeconds === 900, 'finalizer default timeout is not 900 seconds'],
    [fallbackProbe.status === 1, 'synthetic finalizer failure did not remain a failure'],
    [fallbackInvocations.length === 2, 'finalizer did not make exactly one bounded fallback attempt'],
    [fallbackInvocations[0]?.includes('gpt-5.4-mini') && fallbackInvocations[0]?.includes('medium'), 'finalizer primary attempt did not use Mini/medium'],
    [fallbackInvocations[1]?.includes('gpt-5.6-sol-fast') && fallbackInvocations[1]?.includes('xhigh'), 'finalizer fallback did not use Sol Fast/xhigh'],
    [companyWorkflow.includes('create-report-run.mjs "$COMPANY"'), 'company workflow does not create reports deterministically'],
    [companyWorkflow.includes('npm run research:workers -- --report-folder "$REPORT_FOLDER"'), 'company workflow does not invoke the bounded worker runner directly'],
    [companyWorkflow.includes('npm run research:finalize -- --report-folder "$REPORT_FOLDER"'), 'company workflow does not invoke the bounded finalizer directly'],
    [!companyWorkflow.includes('copilot --yolo'), 'company workflow still uses a parent Copilot orchestration session'],
  ];
  const failures = checks.filter(([ok]) => !ok).map(([, message]) => message);
  if (failures.length) throw new Error(failures.join('; '));
  console.log(`[check-chapter-workers] ✓ ${plan.workers.length} independently routed workers + bounded finalizer (${basename(folder)})`);
} catch (error) {
  console.error(`[check-chapter-workers] ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(folder, { recursive: true, force: true });
}
