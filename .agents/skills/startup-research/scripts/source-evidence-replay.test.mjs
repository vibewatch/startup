import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { checkPrefetchedSourceQuotes } from './source-quote-checks.mjs';
import { researchCacheDir } from './utils.mjs';

let sequence = 0;
function fixture() {
  const runId = `20990101000000-evidence-replay-${process.pid}-${sequence++}`;
  const cache = researchCacheDir(runId);
  const name = '0123456789abcdef.txt';
  const text = 'The company announced a funding round subject to closing conditions.';
  const sourcePath = `.research-cache/${runId}/fetched/${name}`;
  const file = join(cache, 'fetched', name);
  const manifestPath = join(cache, 'source-evidence-manifest.json');
  mkdirSync(join(cache, 'fetched'), { recursive: true });
  writeFileSync(file, text);
  const manifest = {
    schemaVersion: 'research-evidence-archive-v1',
    runId,
    workspaceRoot: '/original-runner/work/startup/startup',
    files: [{
      sourcePath,
      archivedPath: `research-evidence/${runId}/fetched/${name}`,
      bytes: Buffer.byteLength(text),
      sha256: createHash('sha256').update(text).digest('hex'),
    }],
    missing: [],
  };
  const fetched = { url: 'https://example.org/funding', ok: true, outputFile: `${manifest.workspaceRoot}/${sourcePath}` };
  const source = { id: 'SO001', url: fetched.url, keyQuote: text };
  return {
    cache, file, manifestPath, manifest, fetched, source,
    save: () => writeFileSync(manifestPath, JSON.stringify(manifest)),
    check: () => checkPrefetchedSourceQuotes([source], [fetched], '01-company-overview.yaml'),
    cleanup: () => rmSync(cache, { recursive: true, force: true }),
  };
}

test('native prefetched sources still work without an archive manifest', () => {
  const f = fixture();
  try {
    f.fetched.outputFile = f.file;
    assert.deepEqual(f.check(), []);
  } finally { f.cleanup(); }
});

test('archived source replay preserves original bundle paths and source bytes', () => {
  const f = fixture();
  try {
    f.save();
    const original = JSON.stringify(f.fetched);
    const bytes = readFileSync(f.file);
    assert.deepEqual(f.check(), []);
    assert.equal(JSON.stringify(f.fetched), original);
    assert.deepEqual(readFileSync(f.file), bytes);
    f.source.keyQuote = 'The funding round has closed.';
    assert.equal(f.check()[0].code, 'sourceQuoteMismatch');
  } finally { f.cleanup(); }
});

test('a hash-matching archived access-error page is still rejected without a quote', () => {
  const f = fixture();
  try {
    const text = '<html><title>404 - Page Not Found</title><body>This page is unavailable.</body></html>';
    writeFileSync(f.file, text);
    f.manifest.files[0].bytes = Buffer.byteLength(text);
    f.manifest.files[0].sha256 = createHash('sha256').update(text).digest('hex');
    f.save();
    f.source.keyQuote = null;
    assert.equal(f.check()[0].code, 'sourceContentBlocked');
  } finally { f.cleanup(); }
});

for (const [name, alter, expected] of [
  ['no manifest', () => {}, /ENOENT/],
  ['invalid manifest', f => { writeFileSync(f.manifestPath, 'not JSON'); }, /JSON/],
  ['wrong run', f => { f.manifest.runId = '20990101000000-other'; f.save(); }, /archive manifest/],
  ['wrong workspace', f => { f.manifest.workspaceRoot = '/different-runner'; f.save(); }, /original source path/],
  ['relative workspace', f => { f.manifest.workspaceRoot = 'relative'; f.save(); }, /archive manifest/],
  ['missing mapping', f => { f.manifest.files = []; f.save(); }, /manifest entry/],
  ['wrong source path', f => { f.manifest.files[0].sourcePath = '../other.txt'; f.save(); }, /manifest entry/],
  ['duplicate mapping', f => { f.manifest.files.push({ ...f.manifest.files[0] }); f.save(); }, /manifest entry/],
  ['wrong archive path', f => { f.manifest.files[0].archivedPath = '../other.txt'; f.save(); }, /manifest entry/],
  ['wrong size', f => { f.manifest.files[0].bytes += 1; f.save(); }, /size or SHA-256/],
  ['changed source bytes', f => { f.save(); writeFileSync(f.file, 'Altered source.'); }, /size or SHA-256/],
  ['wrong digest', f => { f.manifest.files[0].sha256 = '0'.repeat(64); f.save(); }, /size or SHA-256/],
  ['existing native file with invalid digest', f => {
    f.fetched.outputFile = f.file;
    f.manifest.workspaceRoot = process.cwd();
    f.manifest.files[0].sha256 = '0'.repeat(64);
    f.save();
  }, /size or SHA-256/],
  ['missing source', f => { f.save(); rmSync(f.file); }, /ENOENT/],
  ['symlinked source', f => {
    f.save();
    const original = join(f.cache, 'original.txt');
    writeFileSync(original, readFileSync(f.file));
    rmSync(f.file);
    symlinkSync(original, f.file);
  }, /symlink/],
  ['symlinked source directory', f => {
    f.save();
    const original = join(f.cache, 'original-fetched');
    renameSync(join(f.cache, 'fetched'), original);
    symlinkSync(original, join(f.cache, 'fetched'));
  }, /symlink/],
  ['symlinked manifest', f => {
    f.save();
    const original = join(f.cache, 'original-manifest.json');
    renameSync(f.manifestPath, original);
    symlinkSync(original, f.manifestPath);
  }, /symlink/],
]) {
  test(`archive replay fails closed: ${name}`, () => {
    const f = fixture();
    try {
      alter(f);
      const issues = f.check();
      assert.equal(issues.length, 1);
      assert.equal(issues[0].code, 'sourceQuoteTextMissing');
      assert.match(issues[0].message, expected);
    } finally { f.cleanup(); }
  });
}
