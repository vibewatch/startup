#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { EXIT, isRunId } from './utils.mjs';

const [runId, destination, ...extra] = process.argv.slice(2);
if (!isRunId(runId) || !destination || extra.length) {
  console.error('Usage: stage-research-evidence.mjs <runId> <artifact-directory>');
  process.exit(EXIT.failure);
}

try {
  const workspaceRoot = realpathSync(process.cwd());
  const artifactRoot = resolve(destination);
  const archivePrefix = `research-evidence/${runId}`;
  const cachePrefix = `.research-cache/${runId}`;
  if (lstatSync(join(artifactRoot, archivePrefix), { throwIfNoEntry: false })) {
    throw new Error(`Refusing to overwrite an existing evidence archive: ${archivePrefix}`);
  }
  const files = [];
  const missing = [];
  function copy(sourcePath, archiveName, required = false) {
    const source = join(workspaceRoot, sourcePath);
    const stat = lstatSync(source, { throwIfNoEntry: false });
    if (!stat) {
      if (required) missing.push(sourcePath);
      return false;
    }
    if (!stat.isFile() || realpathSync(source) !== source) {
      throw new Error(`Evidence must be a regular, non-symlinked file: ${sourcePath}`);
    }
    const bytes = readFileSync(source);
    const archivedPath = `${archivePrefix}/${archiveName}`;
    const target = join(artifactRoot, archivedPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes, { flag: 'wx' });
    files.push({
      sourcePath,
      archivedPath,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    return true;
  }

  copy(`reports/${runId}/.workflow-snapshot.yaml`, 'workflow-snapshot.yaml', true);
  for (const name of ['search-plan.json', 'search-bundle.json', 'worker-results.json', 'finalizer-result.json', 'refresh-context.yaml', 'refresh-reason-review.json']) {
    copy(`${cachePrefix}/${name}`, name, ['search-bundle.json', 'worker-results.json'].includes(name));
  }
  const localTrail = copy(`${cachePrefix}/_fetch-log.jsonl`, 'fetch-log.jsonl');
  const sharedTrail = copy('.research-cache/_fetch-log.jsonl', 'shared-fetch-log.jsonl');
  if (!localTrail && !sharedTrail) missing.push(`${cachePrefix}/_fetch-log.jsonl or .research-cache/_fetch-log.jsonl`);

  // Only producer-owned evidence files are archived, not environment files or raw model logs.
  for (const [directory, filenamePattern] of [
    ['fetched', /^[a-f0-9]{16}\.txt$/u],
    ['worker-inputs', /^\d{2}-[a-z0-9-]+-(?:context|pool)\.json$/u],
  ]) {
    const relative = `${cachePrefix}/${directory}`;
    const source = join(workspaceRoot, relative);
    const stat = lstatSync(source, { throwIfNoEntry: false });
    let copied = 0;
    if (stat) {
      if (!stat.isDirectory() || realpathSync(source) !== source) {
        throw new Error(`Evidence directory must not be a symlink: ${relative}`);
      }
      for (const name of readdirSync(source).sort()) {
        if (filenamePattern.test(name)) {
          copy(`${relative}/${name}`, `${directory}/${name}`);
          copied++;
        }
      }
    }
    if (!copied) missing.push(`${relative}/`);
  }
  const manifest = {
    schemaVersion: 'research-evidence-archive-v1',
    runId,
    workspaceRoot,
    archivedAt: new Date().toISOString(),
    files,
    missing,
  };
  const manifestPath = join(artifactRoot, archivePrefix, 'manifest.json');
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  if (missing.length) {
    console.warn(`[stage-research-evidence] incomplete evidence archive for ${runId}: ${missing.join(', ')}`);
  }
  console.log(`[stage-research-evidence] ${runId}: preserved ${files.length} original evidence files; manifest: ${manifestPath}`);
} catch (error) {
  console.error(`[stage-research-evidence] ${error.message}`);
  process.exit(EXIT.failure);
}
