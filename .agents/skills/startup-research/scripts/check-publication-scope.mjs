#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = '.agents/skills/startup-research/scripts/check-publication-scope.mjs';
const artifacts = ['summary-card', 'full-report'];
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const paths = output => output.split('\0').filter(Boolean);

function requireTargets(kind, reportIds) {
  if (!['research', 'translation'].includes(kind) || !Array.isArray(reportIds)
      || !reportIds.every(id => typeof id === 'string' && /^\d{14}-[a-z0-9-]+$/.test(id))
      || (kind === 'translation' ? !reportIds.length : reportIds.length > 0)) {
    throw new Error('Invalid publication scope or report IDs.');
  }
}

function readSnapshot(directory) {
  const snapshot = JSON.parse(readFileSync(join(directory, 'scope.json'), 'utf8'));
  requireTargets(snapshot.kind, snapshot.reportIds);
  const expectedInputs = new Set(snapshot.kind === 'translation'
    ? snapshot.reportIds.flatMap(id => artifacts.map(artifact => `reports/${id}/${artifact}.yaml`)) : []);
  if (snapshot.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(snapshot.baseline)
      || !snapshot.englishHashes || typeof snapshot.englishHashes !== 'object' || Array.isArray(snapshot.englishHashes)
      || Object.keys(snapshot.englishHashes).length !== expectedInputs.size
      || !Object.entries(snapshot.englishHashes).every(([path, hash]) => expectedInputs.has(path) && /^[a-f0-9]{64}$/.test(hash))) {
    throw new Error('Invalid publication approval snapshot.');
  }
  return snapshot;
}

function changedPaths(baseline) {
  return [...new Set([
    ...paths(git('diff', '--no-ext-diff', '--no-renames', '--name-only', '-z', baseline, '--')),
    ...paths(git('diff', '--cached', '--no-ext-diff', '--no-renames', '--name-only', '-z', baseline, '--')),
    ...paths(git('ls-files', '--others', '--exclude-standard', '-z')),
  ])].sort();
}

function verifyScope(snapshot) {
  if (git('rev-parse', 'HEAD').trim() !== snapshot.baseline) {
    throw new Error('HEAD changed during generation; the workflow owns commits and rebases.');
  }
  const allowed = new Set(snapshot.reportIds.flatMap(id => artifacts.map(artifact => `reports/${id}/${artifact}.zh.yaml`)));
  const changed = changedPaths(snapshot.baseline);
  const forbidden = changed.filter(path => snapshot.kind === 'research' ? !path.startsWith('reports/') : !allowed.has(path));
  if (forbidden.length) {
    throw new Error(`Changes outside publication output scope: ${JSON.stringify(forbidden)}`);
  }
  for (const path of changed) {
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`Publication output must not be a symlink: ${JSON.stringify(path)}`);
    }
  }
  return changed;
}

function verifyInputs(snapshot) {
  const dirty = changedPaths('HEAD');
  if (dirty.length) throw new Error(`Publication validation requires a clean committed tree: ${JSON.stringify(dirty)}`);
  const changed = Object.entries(snapshot.englishHashes)
    .filter(([path, hash]) => !existsSync(path) || digest(path) !== hash).map(([path]) => path);
  if (changed.length) {
    throw new Error(`Selected English sources changed after translation; rerun against current sources: ${JSON.stringify(changed)}`);
  }
}

function snapshotInputs(directory, kind, reportIds) {
  requireTargets(kind, reportIds);
  const baseline = git('rev-parse', 'HEAD').trim();
  const englishHashes = kind === 'translation'
    ? Object.fromEntries(reportIds.flatMap(id => artifacts.map(artifact => {
      const path = `reports/${id}/${artifact}.yaml`;
      return [path, digest(path)];
    }))) : {};
  const snapshot = { schemaVersion: 1, baseline, kind, reportIds, englishHashes };
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'scope.json'), `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx' });
  writeFileSync(join(directory, 'check-publication-scope.mjs'), git('show', `${baseline}:${scriptPath}`), { flag: 'wx' });
  verifyScope(readSnapshot(directory));
  console.log(`[publication-scope] baseline ${JSON.stringify({ baseline, kind, reportIds })}`);
}

function main() {
  const [operation, directory, kind, ...reportIds] = process.argv.slice(2);
  if (!directory || !['snapshot', 'verify', 'verify-inputs'].includes(operation)
      || (operation === 'snapshot' && (!['research', 'translation'].includes(kind)
        || (kind === 'research' && reportIds.length) || (kind === 'translation' && !reportIds.length)))
      || (operation !== 'snapshot' && kind !== undefined)) {
    throw new Error('Usage: check-publication-scope.mjs snapshot <directory> research|translation [run-id ...] | verify|verify-inputs <directory>');
  }
  if (operation === 'snapshot') snapshotInputs(directory, kind, reportIds);
  else if (operation === 'verify') verifyScope(readSnapshot(directory));
  else verifyInputs(readSnapshot(directory));
  console.log(`[publication-scope] ${operation} passed.`);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`[publication-scope] ${error.message}`);
    process.exitCode = 1;
  }
}
