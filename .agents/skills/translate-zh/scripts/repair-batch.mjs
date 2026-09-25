import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { z } from 'zod';
import { checkPairQuality } from './check-translation-quality.mjs';
import { isTranslatableLeaf, whitelistFor } from './whitelist.mjs';
import { shouldExportLeaf } from './bundle-translatable.mjs';

const batchSchema = z.object({
  reports: z.array(z.object({
    runId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    changes: z.array(z.object({
      artifact: z.enum(['summary-card', 'full-report']),
      path: z.string().min(1),
      english: z.string(),
      before: z.string(),
      after: z.string().refine((value) => value.trim().length > 0, 'translation must not be blank'),
    }).strict()).min(1),
  }).strict()).min(1),
}).strict();

function parsePath(value) {
  return value.split('/').map((part) => /^(?:0|[1-9]\d*)$/.test(part) ? Number(part) : part);
}

function getAt(doc, path) {
  return path.reduce((value, key) => (
    value && Object.hasOwn(value, key) ? value[key] : undefined
  ), doc);
}

function setAt(doc, path, value) {
  const parent = getAt(doc, path.slice(0, -1));
  assert.ok(parent && Object.hasOwn(parent, path.at(-1)), `missing path: ${path.join('/')}`);
  parent[path.at(-1)] = value;
}

function findingsFor(sources, translations, strictEditor) {
  return Object.keys(sources).flatMap((artifact) => (
    checkPairQuality(sources[artifact], translations[artifact], { strictEditor })
      .map((finding) => ({ artifact, ...finding }))
  ));
}

function assertQuality(sources, before, after) {
  const standard = findingsFor(sources, after, false);
  assert.equal(standard.filter((f) => f.severity === 'error').length, 0,
    `proposed repair still fails standard quality: ${JSON.stringify(standard)}`);
  const oldFindings = findingsFor(sources, before, true);
  const newFindings = findingsFor(sources, after, true);
  const remaining = oldFindings.map((finding) => JSON.stringify(finding));
  for (const finding of newFindings) {
    const index = remaining.indexOf(JSON.stringify(finding));
    assert.notEqual(index, -1, `new strict finding: ${JSON.stringify(finding)}`);
    remaining.splice(index, 1);
  }
  const counts = (findings) => ({
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
  });
  return { before: counts(oldFindings), after: counts(newFindings) };
}

export function repairBatch(input, { repoRoot, apply = false }) {
  const batch = batchSchema.parse(JSON.parse(readFileSync(resolve(input), 'utf8')));
  assert.equal(new Set(batch.reports.map((r) => r.runId)).size, batch.reports.length,
    'a report may appear only once in a batch');
  const results = [];
  for (const { runId, changes } of batch.reports) {
    const reportDir = join(repoRoot, 'reports', runId);
    const cacheDir = join(repoRoot, '.translate-cache', runId);
    const originals = new Map();
    const written = new Map();
    try {
      for (const file of readdirSync(reportDir).filter((name) => name.endsWith('.yaml'))) {
        originals.set(file, readFileSync(join(reportDir, file)));
      }
      const sources = {};
      const before = {};
      for (const artifact of ['summary-card', 'full-report']) {
        assert.ok(originals.has(`${artifact}.yaml`) && originals.has(`${artifact}.zh.yaml`),
          `both English and Chinese ${artifact} files are required`);
        sources[artifact] = yaml.load(originals.get(`${artifact}.yaml`).toString('utf8'));
        before[artifact] = yaml.load(originals.get(`${artifact}.zh.yaml`).toString('utf8'));
      }
      const expected = structuredClone(before);
      const targets = new Set();
      for (const change of changes) {
        const { artifact, english, after } = change;
        const path = parsePath(change.path);
        const target = `${artifact}:${change.path}`;
        assert.ok(!targets.has(target), `duplicate target: ${target}`);
        targets.add(target);
        assert.ok(isTranslatableLeaf(path, whitelistFor(sources[artifact])), `preserved field: ${target}`);
        assert.equal(getAt(sources[artifact], path), english, `stale English: ${target}`);
        assert.equal(getAt(before[artifact], path), change.before, `stale Chinese: ${target}`);
        assert.ok(shouldExportLeaf(path, english, whitelistFor(sources[artifact])),
          `target is not an editable sparse leaf: ${target}`);
        assert.notEqual(after, change.before, `unchanged repair: ${target}`);
        setAt(expected[artifact], path, after);
      }
      const quality = assertQuality(sources, before, expected);
      assert.ok(!existsSync(cacheDir), `existing cache must be reviewed or cleaned first: ${cacheDir}`);
      if (!apply) {
        results.push({ runId, status: 'ready', changedLeaves: changes.length, ...quality });
        continue;
      }
      const unchanged = () => {
        for (const [file, bytes] of originals) {
          assert.ok(readFileSync(join(reportDir, file)).equals(written.get(file) ?? bytes),
            `report changed during batch: ${file}`);
        }
      };
      const run = (command, extra = [], output = null) => {
        unchanged();
        const child = spawnSync(process.execPath, [
          join(repoRoot, '.agents/skills/translate-zh/scripts/run-translation.mjs'),
          command, runId, ...extra,
        ], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
        if (output) written.set(output, readFileSync(join(reportDir, output)));
        if (existsSync(cacheDir)) {
          appendFileSync(join(cacheDir, 'batch.log'), `${command}\n${child.stdout ?? ''}${child.stderr ?? ''}`);
        } else if (child.status !== 0) {
          console.error(`${child.stdout ?? ''}${child.stderr ?? ''}`);
        }
        assert.equal(child.status, 0,
          `${command} failed (${child.status ?? child.error?.message}); see ${cacheDir}/batch.log`);
      };
      run('repair-init');
      const partManifest = JSON.parse(readFileSync(join(cacheDir, 'parts/manifest.json'), 'utf8'));
      const bundleFiles = [
        ['summary-card', join(cacheDir, 'summary-card.translate.yaml')],
        ...partManifest.parts.map((part) => ['full-report', join(cacheDir, 'parts', part.file)]),
      ];
      const bundles = bundleFiles.map(([artifact, file]) => ({
        artifact, file, doc: yaml.load(readFileSync(file, 'utf8')), changed: false,
      }));
      for (const change of changes) {
        const path = parsePath(change.path);
        const matches = bundles.filter((bundle) => (
          bundle.artifact === change.artifact && typeof getAt(bundle.doc, path) === 'string'
        ));
        assert.equal(matches.length, 1, `target is not an editable sparse leaf: ${change.path}`);
        setAt(matches[0].doc, path, change.after);
        matches[0].changed = true;
      }
      for (const bundle of bundles.filter((b) => b.changed)) {
        writeFileSync(bundle.file, yaml.dump(bundle.doc, { lineWidth: 120, noRefs: true, sortKeys: false }));
      }
      run('lint-parts');
      for (const artifact of ['summary-card', 'full-report']) {
        if (!changes.some((change) => change.artifact === artifact)) continue;
        run(artifact === 'summary-card' ? 'finalize-summary' : 'finalize-full',
          artifact === 'full-report' ? ['--keep-cache'] : [], `${artifact}.zh.yaml`);
      }
      run('verify');
      const actual = Object.fromEntries(Object.keys(sources).map((artifact) => [
        artifact, yaml.load(readFileSync(join(reportDir, `${artifact}.zh.yaml`), 'utf8')),
      ]));
      assert.deepEqual(actual, expected, 'final outputs changed outside the reviewed leaves');
      unchanged();
      const measured = assertQuality(sources, before, actual);
      run('measure');
      const result = { runId, status: 'applied', changedLeaves: changes.length, ...measured };
      writeFileSync(join(cacheDir, 'batch-result.json'), `${JSON.stringify(result, null, 2)}\n`);
      results.push(result);
    } catch (error) {
      const conflicts = [];
      for (const [file, bytes] of written) {
        if (existsSync(join(reportDir, file)) && readFileSync(join(reportDir, file)).equals(bytes)) {
          writeFileSync(join(reportDir, file), originals.get(file));
        } else {
          conflicts.push(file);
        }
      }
      const message = `${error.message}${conflicts.length ? `; concurrent outputs NOT restored: ${conflicts.join(', ')}` : ''}`;
      console.error(`[translate-zh] batch ${runId}: ${message}`);
      results.push({ runId, status: 'blocked', error: message });
    }
  }
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'preview', reports: results }, null, 2));
  return results.some((result) => result.status === 'blocked') ? 1 : 0;
}
