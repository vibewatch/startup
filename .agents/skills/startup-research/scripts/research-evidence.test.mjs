import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import yaml from 'js-yaml';

for (const workflowFile of ['company.yml', 'refresh-company.yml', 'research-unicorns.yml']) {
  for (const partial of [false, true]) {
    test(`research evidence artifacts: ${workflowFile}, ${partial ? 'partial' : 'complete'} run`, () => {
      const workflow = yaml.load(readFileSync(`.github/workflows/${workflowFile}`, 'utf8'));
      const steps = Object.values(workflow.jobs).flatMap(job => job.steps ?? []);
      const stage = steps.find(step => /^Stage .*report files artifact$/u.test(step.name ?? ''));
      const upload = steps.find(step => step.uses?.startsWith('actions/upload-artifact@')
        && step.with?.path?.includes('generated-reports-artifact'));
      assert.equal(stage.if, 'always()');
      assert.equal(upload.if, 'always()');
      assert.notEqual(upload.with['include-hidden-files'], true, 'Do not expose arbitrary hidden files');
      assert.ok(steps.indexOf(stage) < steps.findIndex(step => step.name === 'Remove incomplete report folders'));

      const root = mkdtempSync(join(tmpdir(), 'research-evidence-test-'));
      const runId = '20990102000000-fixture';
      const previousId = '20990101000000-previous';
      const cache = `.research-cache/${runId}`;
      const runnerTemp = join(root, 'runner-temp');
      const artifact = join(runnerTemp, 'generated-reports-artifact');
      const write = (path, data) => {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), data);
      };
      try {
        const originals = new Map([
          [`reports/${runId}/.workflow-snapshot.yaml`, Buffer.from('activeResearchProfile: fast\n')],
          [`${cache}/search-bundle.json`, Buffer.from(partial ? '{"interrupted":' : '{"fetchedSources":[]}\n')],
          [`${cache}/fetched/0123456789abcdef.txt`, Buffer.from('Original source: $350M; not audited.\n')],
          ['.research-cache/_fetch-log.jsonl', Buffer.from('{"url":"https://example.org/source","ok":true,"status":200}\n')],
        ]);
        if (!partial) {
          originals.set(`${cache}/worker-results.json`, Buffer.from('{"workers":[]}\n'));
          originals.set(`${cache}/worker-inputs/01-company-overview-context.json`, Buffer.from('{"chapter":{"order":1}}\n'));
          originals.set(`${cache}/worker-inputs/01-company-overview-pool.json`, Buffer.from('{"recommended":[]}\n'));
          originals.set(`${cache}/_fetch-log.jsonl`, Buffer.from('{"source":"run-local fixture"}\n'));
          originals.set(`${cache}/refresh-context.yaml`, Buffer.from(`refreshOfRunId: ${previousId}\n`));
          originals.set(`${cache}/refresh-reason-review.json`, Buffer.from('{"schemaVersion":"refresh-reason-review-v1","reviewedReason":"Reader-facing correction"}\n'));
        }

        for (const [path, bytes] of originals) write(path, bytes);
        write(`reports/${runId}/01-company-overview.yaml`, 'partial authored chapter\n');
        write(`reports/${previousId}/report-meta.yaml`, 'previous report metadata\n');
        write(`.research-cache/${previousId}/search-bundle.json`, 'unrelated older cache\n');
        write(`${cache}/env.sh`, 'DO_NOT_ARCHIVE_ENVIRONMENT\n');
        write(`${cache}/.env`, 'DO_NOT_ARCHIVE_HIDDEN_CONFIG\n');
        write(`${cache}/worker-logs/01.log`, 'DO_NOT_ARCHIVE_RAW_MODEL_LOGS\n');
        write('.env', 'DO_NOT_ARCHIVE_WORKSPACE_CONFIG\n');
        write('runner-temp/reports-before.txt', `${previousId}\n`);
        write('runner-temp/summary.txt', '');
        write('runner-temp/git-status', workflowFile === 'refresh-company.yml'
          ? ` M reports/${previousId}/report-meta.yaml\0` : '');
        write('bin/git', '#!/bin/sh\ncase "$1" in\n  rev-parse) exit 0 ;;\n  status) cat "$STAGE_STATUS"; exit 0 ;;\n  *) exit 1 ;;\nesac\n');
        chmodSync(join(root, 'bin/git'), 0o755);
        symlinkSync(resolve('.agents'), join(root, '.agents'), 'dir');

        const result = spawnSync('bash', ['-c', stage.run.replaceAll('${{ steps.inputs.outputs.safeLabel }}', 'fixture')], {
          cwd: root,
          env: {
            ...process.env,
            PATH: `${join(root, 'bin')}:${process.env.PATH}`,
            RUNNER_TEMP: runnerTemp,
            GITHUB_STEP_SUMMARY: join(runnerTemp, 'summary.txt'),
            STAGE_STATUS: join(runnerTemp, 'git-status'),
          },
          encoding: 'utf8',
        });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const evidenceRoot = `research-evidence/${runId}`;
        const manifest = JSON.parse(readFileSync(join(artifact, evidenceRoot, 'manifest.json'), 'utf8'));
        assert.equal(manifest.runId, runId);
        assert.equal(manifest.schemaVersion, 'research-evidence-archive-v1');
        assert.equal(manifest.files.length, originals.size);
        for (const [path, bytes] of originals) {
          const entry = manifest.files.find(file => file.sourcePath === path);
          assert.ok(entry, `Missing original input ${path}`);
          assert.equal(entry.archivedPath.split('/').some(part => part.startsWith('.')), false,
            'Default artifact upload must not exclude the recovery copy');
          assert.deepEqual(readFileSync(join(artifact, entry.archivedPath)), bytes);
          assert.equal(entry.sha256, createHash('sha256').update(bytes).digest('hex'));
          assert.deepEqual(readFileSync(join(root, path)), bytes, 'Archiving must not rewrite original provenance');
        }
        const archivedFiles = manifest.files.map(file => file.sourcePath);
        assert.equal(archivedFiles.some(path => path.includes(previousId) || path.endsWith('/env.sh')
          || path.endsWith('/.env') || path.includes('/worker-logs/')), false);
        assert.equal(existsSync(join(artifact, '.env')), false);
        assert.equal(existsSync(join(artifact, '.research-cache')), false,
          'Do not stage a broad hidden cache that could later expose unreviewed files');
        assert.ok(existsSync(join(artifact, `reports/${runId}/01-company-overview.yaml`)));
        if (workflowFile === 'refresh-company.yml') {
          assert.ok(existsSync(join(artifact, `reports/${previousId}/report-meta.yaml`)));
        }
        if (partial) {
          assert.ok(manifest.missing.includes(`${cache}/worker-results.json`));
          assert.match(result.stderr, /incomplete evidence archive/u);
          assert.equal(existsSync(join(artifact, evidenceRoot, 'worker-results.json')), false);
        } else {
          assert.deepEqual(manifest.missing, []);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

for (const scenario of ['missing-inputs', 'symlink', 'existing-archive', 'invalid-run-id']) {
  test(`research evidence artifacts: ${scenario} is explicit and non-destructive`, () => {
    const root = mkdtempSync(join(tmpdir(), 'research-evidence-failure-test-'));
    const runId = '20990103000000-fixture';
    const artifact = join(root, 'artifact');
    const target = join(artifact, 'research-evidence', runId);
    const write = (path, text) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    };
    try {
      if (scenario === 'symlink') {
        write(join(root, 'outside-source.txt'), 'must not be read through a symlink');
        mkdirSync(join(root, '.research-cache', runId), { recursive: true });
        symlinkSync(join(root, 'outside-source.txt'), join(root, '.research-cache', runId, 'search-bundle.json'));
      }
      if (scenario === 'existing-archive') write(join(target, 'manifest.json'), 'preserve the earlier archive');
      const result = spawnSync(process.execPath, [
        resolve('.agents/skills/startup-research/scripts/stage-research-evidence.mjs'),
        scenario === 'invalid-run-id' ? '../outside' : runId, artifact,
      ], { cwd: root, encoding: 'utf8' });
      if (scenario === 'missing-inputs') {
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stderr, /incomplete evidence archive/u);
        const manifest = JSON.parse(readFileSync(join(target, 'manifest.json'), 'utf8'));
        assert.deepEqual(manifest.files, []);
        assert.ok(manifest.missing.includes(`.research-cache/${runId}/search-bundle.json`));
        assert.ok(manifest.missing.includes(`.research-cache/${runId}/worker-results.json`));
        assert.equal(existsSync(join(target, 'search-bundle.json')), false);
      } else {
        assert.notEqual(result.status, 0);
        assert.equal(existsSync(join(target, 'search-bundle.json')), false);
        if (scenario === 'symlink') assert.match(result.stderr, /non-symlinked file/u);
        if (scenario === 'invalid-run-id') assert.match(result.stderr, /Usage:/u);
        if (scenario === 'existing-archive') {
          assert.match(result.stderr, /Refusing to overwrite/u);
          assert.equal(readFileSync(join(target, 'manifest.json'), 'utf8'), 'preserve the earlier archive');
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
