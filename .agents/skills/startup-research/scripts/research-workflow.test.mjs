import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import yaml from 'js-yaml';

function workflowSteps(file) {
  const workflow = yaml.load(readFileSync(`.github/workflows/${file}`, 'utf8'));
  return Object.values(workflow.jobs).flatMap(job => job.steps ?? []);
}

test('workflow-only pushes trigger full main validation', () => {
  const workflow = yaml.load(readFileSync('.github/workflows/validate-main.yml', 'utf8'));
  assert(workflow.on.push.paths.includes('.github/workflows/**'));
});

for (const file of ['company.yml', 'refresh-company.yml', 'research-unicorns.yml', 'translate-reports-zh.yml', 'benchmark-synthesis-models.yml']) {
  for (const scenario of ['healthy', 'version-lookup-failure', 'platform-download-failure', 'missing-platform']) {
    test(`Copilot installation requires a working version-matched native package: ${file}/${scenario}`, t => {
      const root = mkdtempSync(join(tmpdir(), 'copilot-install-test-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const log = join(root, 'commands.jsonl');
      const writeCommand = (name, body) => {
        const path = join(root, name);
        writeFileSync(path, `#!${process.execPath}\n${body}\n`);
        chmodSync(path, 0o755);
      };
      writeCommand('npm', `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.INSTALL_LOG, JSON.stringify(['npm', ...args]) + '\\n');
if (args[0] === 'view') {
  if (process.env.SCENARIO === 'version-lookup-failure') process.exit(9);
  console.log('1.2.3');
}
if (args.includes('-g') && process.env.SCENARIO === 'platform-download-failure') process.exit(7);
`);
      writeCommand('copilot', `
const fs = require('node:fs');
fs.appendFileSync(process.env.INSTALL_LOG, JSON.stringify(['copilot', ...process.argv.slice(2)]) + '\\n');
if (process.env.SCENARIO === 'missing-platform') {
  console.error('GitHub Copilot CLI: no platform package found.');
  process.exit(1);
}
console.log('GitHub Copilot CLI 1.2.3');
`);
      const workflow = yaml.load(readFileSync(`.github/workflows/${file}`, 'utf8'));
      assert(Object.values(workflow.jobs).every(job => job['runs-on'] === 'ubuntu-latest'));
      const install = workflowSteps(file).find(step => step.name === 'Install dependencies and Copilot CLI');
      const result = spawnSync('bash', ['-e', '-c', install.run], {
        cwd: root, encoding: 'utf8',
        env: { ...process.env, PATH: `${root}:${process.env.PATH}`, INSTALL_LOG: log, SCENARIO: scenario },
      });
      const commands = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      if (scenario === 'version-lookup-failure') {
        assert.equal(result.status, 9, result.stderr);
        assert(!commands.some(command => command.includes('-g') || command[0] === 'copilot'));
        return;
      }
      assert.deepEqual(commands.find(command => command.includes('-g')), [
        'npm', 'install', '-g', '--include=optional', '@github/copilot@1.2.3', '@github/copilot-linux-x64@1.2.3',
      ]);
      if (scenario === 'platform-download-failure') {
        assert.equal(result.status, 7, result.stderr);
        assert(!commands.some(command => command[0] === 'copilot'));
      } else {
        assert.deepEqual(commands.at(-1), ['copilot', '--version']);
        assert.equal(result.status, scenario === 'healthy' ? 0 : 1, result.stderr);
        if (scenario === 'missing-platform') assert.match(result.stderr, /no platform package found/u);
      }
    });
  }
}

test('unicorn discovery uses URL-based repository search without creating a report first', () => {
  const discovery = workflowSteps('research-unicorns.yml')
    .find(step => step.name === 'Generate recent-unicorn diligence reports');
  assert.match(discovery.run, /DISCOVERY_FOLDER="\.research-cache\/\$\(date -u \+%Y%m%d%H%M%S\)-unicorn-discovery"/u);
  assert.match(discovery.run, /search-web\.mjs --report-folder "\$DISCOVERY_FOLDER" --query/u);
  assert.match(discovery.run, /Search snippets and generated summaries alone do not establish eligibility/u);
  assert.match(discovery.run, /If both repository and host discovery are unavailable/u);
  assert.match(discovery.run, /Discovery completed without creating a new report after the bounded retry/u);
});

for (const scenario of ['first-pass-success', 'retry-success', 'no-candidate', 'process-failure']) {
  test(`unicorn discovery retains prior decisions without weakening failure gates: ${scenario}`, t => {
    const { root, repo, runner, runId, write, commit } = publicationFixture(t);
    const bin = join(root, 'bin');
    const callsPath = join(root, 'discovery-calls.jsonl');
    mkdirSync(bin);
    writeFileSync(callsPath, '');
    writeFileSync(join(runner, 'existing-report-identities.tsv'), 'RobCo\thttps://robco.de\n');
    writeFileSync(join(runner, 'reports-before.txt'), `${runId}\n`);
    write('.research-cache/_fetch-log.jsonl', '');
    commit('Discovery fixture baseline');
    const newRun = '20990101000001-new-company';
    const copilot = join(bin, 'copilot');
    writeFileSync(copilot, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1];
const priorCalls = fs.readFileSync(process.env.DISCOVERY_CALLS, 'utf8').trim().split('\\n').filter(Boolean).length;
fs.appendFileSync(process.env.DISCOVERY_CALLS, JSON.stringify({ prompt, priorLog: fs.existsSync(path.join(process.env.RUNNER_TEMP, 'copilot-logs/run.log')) ? fs.readFileSync(path.join(process.env.RUNNER_TEMP, 'copilot-logs/run.log'), 'utf8') : '' }) + '\\n');
const cache = prompt.match(/\\.research-cache\\/[0-9]{14}-unicorn-discovery/)[0];
fs.mkdirSync(path.join(cache, 'search-results'), { recursive: true });
fs.writeFileSync(path.join(cache, 'search-results/query.json'), '{"results":[{"url":"https://example.org/funding"}]}\\n');
fs.writeFileSync(path.join(cache, 'candidate-review.json'), '{"candidates":[{"name":"RobCo","decision":"duplicate","reason":"Already in the identity index."}]}\\n');
console.log('Rejected RobCo: already in the identity index.');
if (process.env.SCENARIO === 'first-pass-success' || (process.env.SCENARIO === 'retry-success' && priorCalls === 1)) fs.mkdirSync('reports/${newRun}');
if (process.env.SCENARIO === 'process-failure') process.exit(7);
`);
    chmodSync(copilot, 0o755);
    const steps = workflowSteps('research-unicorns.yml');
    const execute = step => spawnSync('bash', ['-c', step.run.replaceAll('${{ steps.inputs.outputs.safeLabel }}', 'fixture')], {
      cwd: repo, encoding: 'utf8', timeout: 20000,
      env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, SCENARIO: scenario,
        DISCOVERY_CALLS: callsPath, RUNNER_TEMP: runner,
        GITHUB_STEP_SUMMARY: join(runner, 'summary.txt'),
        STARTUP_FETCH_LOG_PATH: join(repo, '.research-cache/_fetch-log.jsonl'),
        COUNT: '1', INDUSTRY: 'Any', MODEL: 'fixture-model', PROFILE: 'fast',
        INDUSTRY_RULE: 'Choose across different sectors.', CUTOFF_DATE: '2097-01-01',
        COVERAGE_HINT: 'Prefer robotics.', EXISTING_IDENTITIES: join(runner, 'existing-report-identities.tsv'),
      },
    });
    const generated = execute(steps.find(step => step.name === 'Generate recent-unicorn diligence reports'));
    const calls = readFileSync(callsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(generated.status, scenario === 'no-candidate' ? 1 : scenario === 'process-failure' ? 7 : 0, generated.stderr);
    assert.equal(calls.length, ['first-pass-success', 'process-failure'].includes(scenario) ? 1 : 2);
    assert.match(calls[0].prompt, /coverage hint is a preference, not an eligibility restriction/u);
    assert.match(calls[0].prompt, /including AI \/ application software, infrastructure \/ devtools, fintech, and healthcare \/ biotech/u);
    assert.match(calls[0].prompt, /candidate-review\.json/u);
    if (calls.length === 2) {
      assert.match(calls[1].prompt, /Read .*copilot-logs\/run\.log.*candidate-review\.json/u);
      assert.match(calls[1].priorLog, /Rejected RobCo/u);
      assert.match(calls[1].prompt, /Do not query cloud session history/u);
    }
    if (scenario === 'no-candidate') assert.match(generated.stdout, /Discovery completed without creating a new report after the bounded retry/u);
    if (scenario === 'no-candidate' || scenario === 'process-failure') {
      const staged = execute(steps.find(step => step.name === 'Stage new report files artifact'));
      assert.equal(staged.status, 0, staged.stderr);
      const evidence = join(runner, 'generated-reports-artifact/discovery-evidence');
      assert.match(readFileSync(join(evidence, 'copilot-logs/run.log'), 'utf8'), /Rejected RobCo/u);
      const cache = readFileSync(join(runner, 'unicorn-discovery-folder.txt'), 'utf8').trim();
      assert(existsSync(join(evidence, cache.split('/').at(-1), 'candidate-review.json')));
      assert(existsSync(join(evidence, cache.split('/').at(-1), 'search-results/query.json')));
      const upload = steps.find(step => step.name === 'Preserve generated reports artifact');
      assert.equal(upload.if, 'always()');
    }
  });
}

for (const file of ['company.yml', 'refresh-company.yml', 'research-unicorns.yml', 'translate-reports-zh.yml', 'refresh-portfolio.yml']) {
  test(`automation configuration fails before expensive work: ${file}`, () => {
    const steps = workflowSteps(file);
    const preflight = steps.findIndex(step => step.run === 'npm run check:automation-config');
    const work = steps.findIndex(step => /npm run research:bootstrap|\bcopilot [^\n]* -p |plan-refresh-batch\.mjs/u.test(step.run ?? ''));
    assert.ok(preflight >= 0 && work > preflight);
    assert.notEqual(steps[preflight]['continue-on-error'], true);
    if (file === 'translate-reports-zh.yml') {
      assert.equal(steps[preflight].if, "steps.targets.outputs.count != '0'");
    } else {
      assert.equal(steps[preflight].if, undefined);
    }
  });
}

for (const scenario of ['current', 'draft-drift', 'editor-drift', 'repair-drift', 'policy-change']) {
  test(`automation model checks distinguish draft, editor and escalation: ${scenario}`, t => {
    const root = mkdtempSync(join(tmpdir(), 'automation-model-test-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const policyPath = '.agents/skills/startup-research/references/model-routing.yaml';
    const translationPath = '.github/workflows/translate-reports-zh.yml';
    for (const path of [
      policyPath, translationPath,
      '.agents/skills/startup-research/references/search-strategy.yaml',
      '.agents/skills/startup-research/references/workflow-config.yaml',
      '.agents/skills/startup-research/scripts/link-refresh.mjs',
      '.github/workflows/company.yml', '.github/workflows/refresh-company.yml',
      '.github/workflows/research-unicorns.yml',
    ]) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), readFileSync(path));
    }
    const models = yaml.load(readFileSync(join(root, policyPath), 'utf8'));
    const source = readFileSync(translationPath, 'utf8');
    let text = source;
    if (scenario === 'draft-drift') text = text.replace(
      `default: "${models.profiles['translation-draft'].defaultCopilotModel}"`, 'default: "stale-draft-model"');
    if (scenario === 'editor-drift' || scenario === 'policy-change') text = text.replace(
      `--model ${models.profiles['translation-qa'].defaultCopilotModel} -p "$PROMPT"`,
      '--model fixture-editor-model -p "$PROMPT"');
    if (scenario === 'repair-drift' || scenario === 'policy-change') text = text.replace(
      `--model ${models.profiles['translation-qa'].escalateTo} -p "$REPAIR_PROMPT"`,
      '--model fixture-repair-model -p "$REPAIR_PROMPT"');
    if (scenario === 'policy-change') {
      models.profiles['translation-qa'].defaultCopilotModel = 'fixture-editor-model';
      models.profiles['translation-qa'].escalateTo = 'fixture-repair-model';
      writeFileSync(join(root, policyPath), yaml.dump(models));
    }
    if (scenario !== 'current') assert.notEqual(text, source, 'fixture must actually change the workflow route');
    writeFileSync(join(root, translationPath), text);
    const checked = spawnSync(process.execPath, [resolve('.agents/skills/startup-research/scripts/check-automation-config.mjs')], {
      cwd: root, encoding: 'utf8',
    });
    assert.equal(checked.status, scenario.endsWith('-drift') ? 1 : 0, checked.stderr);
    if (scenario.endsWith('-drift')) assert.match(checked.stderr, /model must match model-routing profile/u);
  });
}

function publicationFixture(t, runId = '20990101000000-fixture') {
  const root = mkdtempSync(join(tmpdir(), 'publication-scope-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  const runner = join(root, 'runner');
  const approval = join(runner, 'publication-approval');
  const script = '.agents/skills/startup-research/scripts/check-publication-scope.mjs';
  const write = (path, contents) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), contents);
  };
  const gitAt = (cwd, ...args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const git = (...args) => gitAt(repo, ...args);
  const run = (path, ...args) => spawnSync(process.execPath, [path, ...args], { cwd: repo, encoding: 'utf8' });
  mkdirSync(repo);
  mkdirSync(runner);
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.name', 'Scope Fixture');
  git('config', 'user.email', 'scope@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '/dev/null');
  write('.gitignore', '.translate-cache/\n.research-cache/\n');
  write(script, readFileSync(script));
  write('scripts/checker.mjs', 'export const amount = "$10M";\n');
  for (const artifact of ['summary-card', 'full-report']) write(`reports/${runId}/${artifact}.yaml`, 'amount: $10M\n');
  const commit = message => {
    git('add', '.');
    git('commit', '--quiet', '-m', message);
  };
  return { root, repo, runner, approval, runId, script, write, gitAt, git, run, commit };
}

function publicationWorkflowFixture(t, file) {
  const fixture = publicationFixture(t);
  const { root, repo, runner, runId, write, commit } = fixture;
  const bin = join(root, 'bin');
  const gradeLog = join(root, 'grades.jsonl');
  mkdirSync(bin);
  writeFileSync(gradeLog, '');
  const grade = `import fs from 'node:fs'; import { execFileSync } from 'node:child_process';
fs.appendFileSync(process.env.GRADE_LOG, JSON.stringify([...process.argv.slice(1), 'HEAD:' + execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()]) + '\\n');\n`;
  for (const path of [
    '.agents/skills/startup-research/scripts/check-report.mjs',
    '.agents/skills/translate-zh/scripts/check-translation.mjs',
    '.agents/skills/translate-zh/scripts/check-translation-quality.mjs',
  ]) write(path, grade);
  writeFileSync(join(bin, 'npm'), `#!${process.execPath}
const fs = require('node:fs');
const head = require('node:child_process').execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
fs.appendFileSync(process.env.GRADE_LOG, JSON.stringify(['npm', ...process.argv.slice(2), 'HEAD:' + head]) + '\\n');
`);
  chmodSync(join(bin, 'npm'), 0o755);
  writeFileSync(join(runner, 'reports-new.txt'), `${runId}\n`);
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, REPORT_IDS: runId,
    RUNNER_TEMP: runner, GRADE_LOG: gradeLog, SAFE_LABEL: 'fixture', LABEL: 'fixture',
    GH_TOKEN: 'fixture-startup-token',
    GITHUB_STEP_SUMMARY: join(runner, 'summary.txt'),
  };
  const steps = workflowSteps(file);
  const execute = step => spawnSync('bash', ['-c', step.run
    .replaceAll('${{ github.ref_name }}', 'main')
    .replaceAll('${{ steps.targets.outputs.count }}', '1')
    .replaceAll('${{ secrets.GITHUB_TOKEN }}', 'fixture-only-token')], {
    cwd: repo, env, encoding: 'utf8', timeout: 20000,
  });
  commit('Fixture approval inputs');
  const snapshot = execute(steps.find(step => step.name === 'Snapshot publication approval inputs'));
  assert.equal(snapshot.status, 0, snapshot.stderr);
  for (const artifact of ['summary-card', 'full-report']) write(`reports/${runId}/${artifact}.zh.yaml`, 'amount: $10M\n');
  return {
    ...fixture, steps, execute, gradeLog,
    grades: () => readFileSync(gradeLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
  };
}

test('editorial workers cannot run lifecycle commands or delete the prepared cache', t => {
  const { repo, runId, write } = publicationFixture(t);
  const runner = resolve('.agents/skills/translate-zh/scripts/run-translation.mjs');
  const checkpoint = `.translate-cache/${runId}/validated-draft/full-report.zh.yaml`;
  const part = `.translate-cache/${runId}/parts/part.001.yaml`;
  write(checkpoint, 'checkpoint: unchanged\n');
  write(part, 'body: prepared\n');
  for (const command of ['preflight', 'init', 'editor-init', 'finalize-full', 'editor-accept', 'editor-restore', 'cleanup']) {
    const result = spawnSync(process.execPath, [runner, command, runId], {
      cwd: repo, encoding: 'utf8',
      env: { ...process.env, STARTUP_TRANSLATION_EDITOR_WORKER: '1' },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Editorial workers must edit only the prepared/u);
    assert.equal(readFileSync(join(repo, checkpoint), 'utf8'), 'checkpoint: unchanged\n');
    assert.equal(readFileSync(join(repo, part), 'utf8'), 'body: prepared\n');
  }
  const workflow = yaml.load(readFileSync('.github/workflows/translate-reports-zh.yml', 'utf8'));
  const steps = workflow.jobs.translate.steps;
  assert.equal(workflow.env?.STARTUP_TRANSLATION_EDITOR_WORKER, undefined);
  assert.equal(workflow.jobs.translate.env?.STARTUP_TRANSLATION_EDITOR_WORKER, undefined);
  assert.equal(steps.find(step => step.id === 'editor').env.STARTUP_TRANSLATION_EDITOR_WORKER, '1');
  const acceptance = steps.find(step => step.name === 'Validate or roll back editorial pass');
  assert.equal(acceptance.env.STARTUP_TRANSLATION_EDITOR_WORKER, undefined);
  assert.match(acceptance.run, /STARTUP_TRANSLATION_EDITOR_WORKER=1 copilot .*"\$REPAIR_PROMPT"/u);
  const parent = spawnSync(process.execPath, [runner, '--help'], {
    encoding: 'utf8', env: { ...process.env, STARTUP_TRANSLATION_EDITOR_WORKER: '' },
  });
  assert.equal(parent.status, 0, parent.stderr);
});

for (const scenario of [
  'selected-overlays', 'checker-edit', 'staged-checker-edit', 'guard-edit', 'english-edit',
  'unselected-overlay', 'untracked-code', 'model-commit', 'dangling-symlink',
  'research-refresh-outputs', 'unrelated-rebase', 'source-rebase', 'missing-source-hash', 'research-invalid-hashes',
  'legacy-run-id',
]) {
  test(`publication approval scope rejects unpublished inputs: ${scenario}`, t => {
    const { repo, approval, runId, script, write, git, run, commit } = publicationFixture(t,
      scenario === 'legacy-run-id' ? '20990101000000-fixture--legacy-' : undefined);
    commit('Fixture baseline');
    const research = scenario === 'research-refresh-outputs' || scenario === 'research-invalid-hashes';
    const snapshot = run(script, 'snapshot', approval, research ? 'research' : 'translation', ...(research ? [] : [runId]));
    assert.equal(snapshot.status, 0, snapshot.stderr);
    const frozen = join(approval, 'check-publication-scope.mjs');
    write(`reports/${runId}/summary-card.zh.yaml`, 'amount: $10M\n');
    write(`reports/${runId}/full-report.zh.yaml`, 'amount: $10M\n');
    write('.translate-cache/part.yaml', 'body: draft\n');
    let expected = 1;
    let message = /outside publication output scope/;
    if (scenario === 'selected-overlays' || scenario === 'legacy-run-id') expected = 0;
    if (scenario === 'checker-edit' || scenario === 'staged-checker-edit') {
      write('scripts/checker.mjs', 'process.exit(0);\n');
      if (scenario === 'staged-checker-edit') {
        git('add', 'scripts/checker.mjs');
        write('scripts/checker.mjs', 'export const amount = "$10M";\n');
      }
    }
    if (scenario === 'guard-edit') write(script, 'process.exit(0);\n');
    if (scenario === 'english-edit') write(`reports/${runId}/full-report.yaml`, 'amount: $11M\n');
    if (scenario === 'unselected-overlay') write('reports/20990101000001-other/full-report.zh.yaml', 'body: draft\n');
    if (scenario === 'untracked-code') write('scripts/new-checker.mjs', 'process.exit(0);\n');
    if (scenario === 'model-commit') {
      git('add', 'reports');
      git('commit', '--quiet', '-m', 'Unapproved model commit');
      message = /HEAD changed during generation/;
    }
    if (scenario === 'dangling-symlink') {
      rmSync(join(repo, `reports/${runId}/summary-card.zh.yaml`));
      symlinkSync('missing.yaml', join(repo, `reports/${runId}/summary-card.zh.yaml`));
      message = /must not be a symlink/;
    }
    if (research) {
      write('reports/20990101000001-refresh/report-meta.yaml', 'revision: current\n');
      write(`reports/${runId}/full-report.yaml`, 'revision: superseded\n');
      expected = 0;
    }
    if (scenario === 'missing-source-hash' || scenario === 'research-invalid-hashes') {
      const file = join(approval, 'scope.json');
      const snapshot = JSON.parse(readFileSync(file, 'utf8'));
      if (scenario === 'missing-source-hash') delete snapshot.englishHashes[`reports/${runId}/full-report.yaml`];
      else snapshot.englishHashes = true;
      writeFileSync(file, JSON.stringify(snapshot));
      expected = 1;
      message = /Invalid publication approval snapshot/;
    }
    if (scenario.endsWith('-rebase')) {
      git('add', 'reports');
      git('commit', '--quiet', '-m', 'Approved output');
      write('README.md', 'Unrelated upstream change\n');
      if (scenario === 'source-rebase') write(`reports/${runId}/full-report.yaml`, 'amount: $10M\nbasis: changed proposition\n');
      git('add', '.');
      git('commit', '--quiet', '-m', 'Upstream changes after approval');
      expected = scenario === 'source-rebase' ? 1 : 0;
      message = /Selected English sources changed after translation/;
    }
    const result = run(frozen, scenario.endsWith('-rebase') ? 'verify-inputs' : 'verify', approval);
    assert.equal(result.status, expected, result.stderr);
    if (expected) assert.match(result.stderr, message);
    if (scenario === 'guard-edit') assert.equal(readFileSync(join(repo, script), 'utf8'), 'process.exit(0);\n');
  });
}

for (const file of ['company.yml', 'refresh-company.yml', 'research-unicorns.yml', 'translate-reports-zh.yml']) {
  test(`publication workflow rejects modified graders before executing them: ${file}`, t => {
    const { steps, execute, gradeLog, grades, write, script } = publicationWorkflowFixture(t, file);
    const snapshotIndex = steps.findIndex(step => step.name === 'Snapshot publication approval inputs');
    const modelIndex = steps.findIndex(step => /npm run research:bootstrap|\bcopilot [^\n]* -p /u.test(step.run ?? ''));
    assert.ok(snapshotIndex >= 0 && modelIndex > snapshotIndex);
    const verify = steps.find(step => /^(?:Verify selected translations|Validate (?:generated|refreshed) reports)$/u.test(step.name));
    const valid = execute(verify);
    assert.equal(valid.status, 0, valid.stderr);
    assert.ok(grades().length > 0, 'positive control must execute the grader');
    writeFileSync(gradeLog, '');
    write(script, 'process.exit(0);\n');
    write('.agents/skills/translate-zh/scripts/check-translation-quality.mjs', 'process.exit(0);\n');
    const rejected = execute(verify);
    assert.equal(rejected.status, 1, rejected.stderr);
    assert.match(rejected.stderr, /outside publication output scope/u);
    assert.deepEqual(grades(), [], 'a modified grader must never be used for approval');
    const publish = steps.find(step => step.name.startsWith('Commit and publish'));
    assert.ok(publish.run.indexOf(' verify ') < publish.run.indexOf('git add '));
    assert.doesNotMatch(publish.run, /--autostash|publishing existing local commit/u);
  });

  for (const change of ['unrelated', 'dependencies', ...(file === 'translate-reports-zh.yml'
    ? ['english', 'reports-only', 'reports-invalid', 'reports-and-code'] : [])]) {
    test(`publication workflow revalidates a real rebase: ${file}, ${change}`, t => {
      const { root, repo, steps, execute, grades, git, gitAt, runId } = publicationWorkflowFixture(t, file);
      const remote = join(root, 'remote.git');
      const upstream = join(root, 'upstream');
      git('init', '--quiet', '--bare', '--initial-branch=main', remote);
      git('remote', 'add', 'origin', remote);
      git('push', '--quiet', 'origin', 'HEAD:main');
      git('clone', '--quiet', remote, upstream);
      for (const [key, value] of [['user.name', 'Scope Fixture'], ['user.email', 'scope@example.invalid'],
        ['commit.gpgsign', 'false'], ['core.hooksPath', '/dev/null']]) gitAt(upstream, 'config', key, value);
      if (change === 'english') {
        writeFileSync(join(upstream, `reports/${runId}/full-report.yaml`), 'amount: $10M\nbasis: changed proposition\n');
      } else if (change === 'dependencies') {
        writeFileSync(join(upstream, 'package.json'), '{"name":"fixture","private":true}\n');
      } else if (change.startsWith('reports-')) {
        mkdirSync(join(upstream, 'reports/20990101000001-concurrent'));
        writeFileSync(join(upstream, 'reports/20990101000001-concurrent/report-meta.yaml'), 'revision: current\n');
        if (change === 'reports-and-code') {
          writeFileSync(join(upstream, 'scripts/checker.mjs'), 'export const amount = "$20M";\n');
        }
      } else {
        writeFileSync(join(upstream, 'README.md'), 'Unrelated upstream change\n');
      }
      gitAt(upstream, 'add', '.');
      gitAt(upstream, 'commit', '--quiet', '-m', 'Concurrent upstream change');
      gitAt(upstream, 'push', '--quiet', 'origin', 'main');
      const upstreamHead = gitAt(upstream, 'rev-parse', 'HEAD');
      if (change === 'reports-invalid') {
        const npm = join(root, 'bin', 'npm');
        writeFileSync(npm, `${readFileSync(npm, 'utf8')}
if (process.argv.includes('check:reports-contract')) {
  console.error('fixture: concurrent report contract violation');
  process.exit(12);
}
`);
      }
      const result = execute(steps.find(step => step.name.startsWith('Commit and publish')));
      assert.equal(result.error, undefined, result.error?.message);
      if (change === 'english') {
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /Selected English sources changed after translation/u);
        assert.equal(git('--git-dir', remote, 'rev-parse', 'main'), upstreamHead, 'source drift must block the push');
        assert.deepEqual(grades(), [], 'source drift must stop before grading against changed prose');
      } else if (change === 'reports-invalid') {
        assert.equal(result.status, 12, result.stderr);
        assert.match(result.stderr, /concurrent report contract violation/u);
        assert.equal(git('--git-dir', remote, 'rev-parse', 'main'), upstreamHead,
          'failed report-only revalidation must block publication');
        assert(!grades().some(args => args.includes('check:translations-zh') || args.includes('validate')),
          'a failed contract must stop retries rather than fall back to success');
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.notEqual(git('rev-parse', 'HEAD'), upstreamHead);
        assert.equal(git('--git-dir', remote, 'rev-parse', 'main'), git('rev-parse', 'HEAD'));
        assert.ok(grades().some(args => args.some(arg => arg.endsWith('/check-report.mjs')
          || arg.endsWith('/check-translation-quality.mjs'))), 'rebased output must be regraded');
        assert.ok(grades().every(args => args.at(-1) === `HEAD:${git('rev-parse', 'HEAD')}`),
          'approval must inspect the rebased commit, not the pre-fetch tree');
        assert.equal(grades().some(args => args[0] === 'npm' && args[1] === 'ci'), change === 'dependencies');
        if (file === 'translate-reports-zh.yml') {
          const checks = grades().filter(args => args[0] === 'npm' && args[1] === 'run').map(args => args[2]);
          assert.deepEqual(checks, change === 'reports-only'
            ? ['check:revision-graph', 'check:reports-contract', 'check:translations-zh'] : ['validate']);
        }
        assert.equal(git('status', '--porcelain'), '');
        assert.ok(existsSync(join(repo, `reports/${runId}/full-report.zh.yaml`)));
      }
    });
  }

  for (const outcome of ['created', 'permission-denied']) {
    test(`publication fallback uses the repository PAT and surfaces PR errors: ${file}/${outcome}`, t => {
      const { root, steps, execute, git } = publicationWorkflowFixture(t, file);
      const remote = join(root, 'remote.git');
      const bin = join(root, 'bin');
      const tokenLog = join(root, 'pr.json');
      const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
      git('init', '--quiet', '--bare', '--initial-branch=main', remote);
      git('remote', 'add', 'origin', remote);
      git('push', '--quiet', 'origin', 'HEAD:main');
      for (const [name, body] of [
        ['git', `
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === 'push' && args.at(-1) === 'HEAD:main') {
  console.error('fixture: concurrent main publication rejected this push');
  process.exit(1);
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status);
`],
        ['sleep', ''],
        ['gh', `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(tokenLog)}, JSON.stringify({ args: process.argv.slice(2), token: process.env.GH_TOKEN }));
if (${JSON.stringify(outcome)} === 'permission-denied') {
  console.error('fixture: repository PAT needs pull-request write permission');
  process.exit(9);
}
console.log('https://github.com/example/fixture/pull/1');
`],
      ]) {
        writeFileSync(join(bin, name), `#!${process.execPath}\n${body}`);
        chmodSync(join(bin, name), 0o755);
      }
      const publish = steps.find(step => step.name.startsWith('Commit and publish'));
      assert.equal(publish.env.GH_TOKEN, '${{ secrets.STARTUP_PAT }}');
      const result = execute(publish);
      assert.equal(result.status, outcome === 'created' ? 0 : 9, result.stderr);
      assert.deepEqual(JSON.parse(readFileSync(tokenLog, 'utf8')).token, 'fixture-startup-token',
        'fallback reverted to the Actions token forbidden by repository policy');
      const branches = git('--git-dir', remote, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/');
      assert.match(branches, /auto\//u, 'validated output must remain on its recovery branch');
      if (outcome === 'permission-denied') assert.match(result.stderr, /pull-request write permission/u);
    });
  }
}

for (const scenario of ['editor-edit', 'repair-edit', 'failed-repair-edit']) {
  test(`editorial scope violations abort before grading or rollback: ${scenario}`, t => {
    const { root, runner, steps, execute, grades, write } = publicationWorkflowFixture(t, 'translate-reports-zh.yml');
    const checker = '.agents/skills/translate-zh/scripts/check-translation-quality.mjs';
    if (scenario === 'editor-edit') write(checker, 'process.exit(0);\n');
    else {
      mkdirSync(join(runner, 'copilot-logs'));
      writeFileSync(join(root, 'bin', 'npm'), `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(process.env.GRADE_LOG, JSON.stringify(['npm', ...process.argv.slice(2)]) + '\\n');
if (process.argv.includes('editor-accept')) process.exit(1);
`);
      writeFileSync(join(root, 'bin', 'copilot'), `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(checker)}, 'process.exit(0);\\n');
process.exit(${scenario === 'failed-repair-edit' ? 1 : 0});
`);
      chmodSync(join(root, 'bin', 'copilot'), 0o755);
    }
    const result = execute(steps.find(step => step.name === 'Validate or roll back editorial pass'));
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /outside publication output scope/u);
    assert.equal(grades().some(args => args.includes('editor-restore')), false, 'do not restore through modified scripts');
    if (scenario === 'editor-edit') assert.deepEqual(grades(), []);
    else assert.equal(grades().filter(args => args.includes('editor-accept')).length, 1,
      'the bounded repair must not be graded after it changes a checker');
  });
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
