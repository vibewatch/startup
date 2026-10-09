import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { planReportPruning, pruneSupersededReports, readReportRedirects } from './report-retention.mjs';
import { parseReportRunId, reportRedirectRoutes } from '../../../../website/src/lib/report-paths.mjs';
import { getCoreArtifacts, loadWorkflowConfig } from './utils.mjs';

const oldId = '20980101000000-fixture';
const priorId = '20990101000000-fixture';
const currentId = '21000101000000-fixture';
const futureId = '21010101000000-fixture';
const company = { name: 'Fixture', website: 'https://fixture.example' };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'report-retention-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const reports = join(root, 'reports');
  mkdirSync(reports);
  const writeReport = (runId, revision, { translated = true, identity = company } = {}) => {
    const folder = join(reports, runId);
    mkdirSync(folder, { recursive: true });
    for (const file of ['report-meta.yaml', 'summary-card.yaml', 'full-report.yaml', 'evidence.yaml',
      ...(translated ? ['summary-card.zh.yaml', 'full-report.zh.yaml'] : [])]) {
      writeFileSync(join(folder, file), JSON.stringify({
        company: identity, revision, text: `${runId}: retained ${file}`,
      }));
    }
    writeFileSync(join(folder, '.workflow-snapshot.yaml'), 'original workflow snapshot\n');
    return folder;
  };
  const revision = (status, parent, replacement = null) => ({
    status, refreshOfRunId: parent, supersededByRunId: replacement, refreshReason: parent ? 'Refresh accepted English evidence.' : null,
  });
  writeReport(oldId, revision('superseded', null, priorId));
  writeReport(priorId, revision('superseded', oldId, currentId));
  writeReport(currentId, revision('current', priorId), { translated: false });
  const bytes = () => new Map(readdirSync(join(reports, currentId))
    .map(file => [file, readFileSync(join(reports, currentId, file))]));
  return { root, reports, writeReport, revision, bytes };
}

test('pruning preview resolves entire chains without changing any files or requiring current Chinese', t => {
  const { reports, bytes } = fixture(t);
  const before = bytes();
  const plan = planReportPruning(reports);
  assert.deepEqual(plan.removals, [
    { runId: oldId, targetRunId: currentId }, { runId: priorId, targetRunId: currentId },
  ]);
  assert.deepEqual(bytes(), before);
  assert(existsSync(join(reports, oldId, 'full-report.zh.yaml')));
  assert(!existsSync(join(reports, '.redirects')));
});

test('pruning deletes complete old folders and preserves every current byte; repetition is a no-op', t => {
  const { reports, bytes } = fixture(t);
  const before = bytes();
  assert.equal(pruneSupersededReports(reports).removals.length, 2);
  assert(!existsSync(join(reports, oldId)));
  assert(!existsSync(join(reports, priorId)));
  assert.deepEqual(bytes(), before);
  const redirects = readReportRedirects(reports);
  assert.deepEqual(redirects, { [oldId]: currentId, [priorId]: currentId });
  for (const runId of [oldId, priorId]) {
    assert.equal(readFileSync(join(reports, '.redirects', `${runId}.json`), 'utf8'), `${JSON.stringify(currentId)}\n`);
  }
  assert.equal(pruneSupersededReports(reports).removals.length, 0);
  assert.deepEqual(bytes(), before);
});

test('subsequent refreshes collapse existing redirects directly to the latest current report', t => {
  const { reports, writeReport, revision } = fixture(t);
  pruneSupersededReports(reports);
  writeReport(currentId, revision('superseded', priorId, futureId));
  writeReport(futureId, revision('current', currentId));
  assert.equal(pruneSupersededReports(reports).removals.length, 1);
  assert.deepEqual(readReportRedirects(reports), {
    [oldId]: futureId, [priorId]: futureId, [currentId]: futureId,
  });
  assert(!existsSync(join(reports, currentId)));
  assert(existsSync(join(reports, futureId, 'full-report.zh.yaml')));
});

test('historical metadata may omit revisions without changing published-artifact consistency or current bytes', t => {
  const { reports, bytes } = fixture(t);
  for (const runId of [oldId, priorId, currentId]) {
    const path = join(reports, runId, 'report-meta.yaml');
    const document = JSON.parse(readFileSync(path, 'utf8'));
    delete document.revision;
    writeFileSync(path, JSON.stringify(document));
  }
  const before = bytes();
  assert.equal(pruneSupersededReports(reports).removals.length, 2);
  assert.deepEqual(bytes(), before);
});

for (const failure of ['missing', 'cycle', 'foreign-company', 'unfinished', 'revision-drift', 'back-pointer', 'symlink', 'invalid-redirect']) {
  test(`unsafe replacement blocks pruning before any file is removed: ${failure}`, t => {
    const { reports, writeReport, revision } = fixture(t);
    if (failure === 'missing') rmSync(join(reports, currentId), { recursive: true });
    if (failure === 'cycle') writeReport(currentId, revision('superseded', priorId, oldId));
    if (failure === 'foreign-company') writeReport(currentId, revision('current', priorId),
      { identity: { name: 'Unrelated', website: 'https://other.example' } });
    if (failure === 'unfinished') rmSync(join(reports, currentId, 'evidence.yaml'));
    if (failure === 'revision-drift') writeFileSync(join(reports, currentId, 'full-report.yaml'),
      JSON.stringify({ company, revision: revision('current', oldId) }));
    if (failure === 'back-pointer') writeReport(currentId, revision('current', oldId));
    if (failure === 'symlink') {
      rmSync(join(reports, currentId), { recursive: true });
      symlinkSync(join(reports, priorId), join(reports, currentId), 'dir');
    }
    if (failure === 'invalid-redirect') {
      mkdirSync(join(reports, '.redirects'));
      writeFileSync(join(reports, '.redirects', `${oldId}.json`), '"../outside"\n');
    }
    assert.throws(() => pruneSupersededReports(reports));
    assert(existsSync(join(reports, oldId, 'full-report.zh.yaml')));
    assert(existsSync(join(reports, priorId, 'full-report.yaml')));
    if (failure !== 'invalid-redirect') assert(!existsSync(join(reports, '.redirects')));
  });
}

test('redirects cover both locales and preserve existing report slugs and configured base paths', () => {
  assert.deepEqual(parseReportRunId('20260504023841-openai'),
    { runTimestamp: '20260504023841', folderSlug: 'openai-c4bcc2' });
  const routes = reportRedirectRoutes({ [oldId]: currentId }, '/startup');
  const oldSlug = parseReportRunId(oldId).folderSlug;
  const newSlug = parseReportRunId(currentId).folderSlug;
  assert.equal(routes[`/${oldSlug}/`], `/startup/${newSlug}/`);
  assert.equal(routes[`/zh/${oldSlug}/`], `/startup/zh/${newSlug}/`);
  assert.equal(Object.keys(routes).length, 2);
});

test('revision graph accepts explicit retired parents and rejects missing or live-source redirect records', t => {
  const { root, reports } = fixture(t);
  pruneSupersededReports(reports);
  const scripts = join(root, '.agents/skills/startup-research/scripts');
  cpSync(new URL('./', import.meta.url), scripts, { recursive: true });
  cpSync(new URL('../../../../website/src/lib/', import.meta.url), join(root, 'website/src/lib'), { recursive: true });
  symlinkSync(fileURLToPath(new URL('../../../../node_modules', import.meta.url)), join(root, 'node_modules'), 'dir');
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  const run = () => spawnSync(process.execPath, [
    join(scripts, 'check-revision-graph.mjs'), '--format', 'json',
  ], { cwd: root, encoding: 'utf8' });
  let child = run();
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.equal(JSON.parse(child.stdout).summary.retiredReports, 2);
  mkdirSync(join(reports, priorId));
  child = run();
  assert.equal(child.status, 1, child.stderr || child.stdout);
  assert(JSON.parse(child.stdout).issues.some(issue => issue.code === 'revisionGraph.retiredReportPresent'));
  rmSync(join(reports, priorId), { recursive: true });
  const evidence = join(reports, currentId, 'evidence.yaml');
  const bytes = readFileSync(evidence);
  rmSync(evidence);
  child = run();
  assert.equal(child.status, 1, child.stderr || child.stdout);
  assert(JSON.parse(child.stdout).issues.some(issue => issue.code === 'revisionGraph.invalidRedirect'));
  writeFileSync(evidence, bytes);
  rmSync(join(reports, '.redirects', `${priorId}.json`));
  child = run();
  assert.equal(child.status, 1, child.stderr || child.stdout);
  assert(JSON.parse(child.stdout).issues.some(issue => issue.code === 'revisionGraph.missingTarget'));
  writeFileSync(join(reports, '.redirects', `${priorId}.json`), JSON.stringify(currentId));
  writeFileSync(join(reports, '.redirects', `${currentId}.json`), JSON.stringify(oldId));
  child = run();
  assert.equal(child.status, 1, child.stderr || child.stdout);
  assert(JSON.parse(child.stdout).issues.some(issue => issue.code === 'revisionGraph.retiredReportPresent'));
});

test('report-contract cache is invalidated when a retired-parent record changes', t => {
  const { root, reports } = fixture(t);
  pruneSupersededReports(reports);
  const scripts = join(root, '.agents/skills/startup-research/scripts');
  cpSync(new URL('./', import.meta.url), scripts, { recursive: true });
  cpSync(new URL('../../../../website/src/lib/', import.meta.url), join(root, 'website/src/lib'), { recursive: true });
  symlinkSync(fileURLToPath(new URL('../../../../node_modules', import.meta.url)), join(root, 'node_modules'), 'dir');
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(scripts, 'check-report.mjs'), `
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {reportsDir} from './utils.mjs';
export function checkRun(runId){
 const revision=JSON.parse(readFileSync(join(reportsDir,runId,'summary-card.yaml'),'utf8')).revision;
 const path=join(reportsDir,'.redirects',revision.refreshOfRunId+'.json');
 const ok=!existsSync(join(reportsDir,revision.refreshOfRunId))&&existsSync(path)&&JSON.parse(readFileSync(path,'utf8'))===runId;
 return {checked:true,failures:ok?[]:[{path,code:'revision.targetMissing',message:'Exact retired parent required'}]};
}`);
  const run = () => spawnSync(process.execPath, [join(scripts, 'check-reports.mjs'), '--format', 'json'], {
    cwd: root, encoding: 'utf8',
  });
  let child = run();
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.equal(JSON.parse(child.stdout).summary.reCheckedReports, 1);
  child = run();
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.equal(JSON.parse(child.stdout).summary.cachedReports, 1);
  const path = join(reports, '.redirects', `${priorId}.json`);
  writeFileSync(path, JSON.stringify(futureId));
  child = run();
  assert.equal(child.status, 1, 'changed redirect must not retain a cached contract pass');
  writeFileSync(path, JSON.stringify(currentId));
  assert.equal(run().status, 0);
  mkdirSync(join(reports, priorId));
  assert.equal(run().status, 1, 'a partial predecessor folder must invalidate the retired-parent pass');
  rmSync(join(reports, priorId), { recursive: true });
  assert.equal(run().status, 0);
  rmSync(path);
  assert.equal(run().status, 1, 'deleted redirect must not retain a cached contract pass');
});

test('per-report contracts require exact retired parents and reject partial folders and invalid records', t => {
  const { root, reports } = fixture(t);
  pruneSupersededReports(reports);
  const scripts = join(root, '.agents/skills/startup-research/scripts');
  cpSync(new URL('./', import.meta.url), scripts, { recursive: true });
  cpSync(new URL('../references/', import.meta.url), join(scripts, '../references'), { recursive: true });
  cpSync(new URL('../../../../website/src/lib/', import.meta.url), join(root, 'website/src/lib'), { recursive: true });
  symlinkSync(fileURLToPath(new URL('../../../../node_modules', import.meta.url)), join(root, 'node_modules'), 'dir');
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  rmSync(join(reports, currentId, '.workflow-snapshot.yaml'));
  for (const { file } of getCoreArtifacts(loadWorkflowConfig())) {
    if (!existsSync(join(reports, currentId, file))) writeFileSync(join(reports, currentId, file), '{}');
  }
  const revisionFindings = () => {
    const child = spawnSync(process.execPath, [
      join(scripts, 'check-report.mjs'), currentId, '--contract', '--format', 'json',
    ], { cwd: root, encoding: 'utf8' });
    // This minimal fixture intentionally omits unrelated content fields.
    assert.equal(child.status, 1, child.stderr || child.stdout);
    const result = JSON.parse(child.stdout);
    assert(!result.issues.some(issue => issue.dimension === 'missingArtifact'));
    return result.issues.filter(issue => issue.dimension === 'revisionGraph');
  };
  assert.deepEqual(revisionFindings(), []);
  const path = join(reports, '.redirects', `${priorId}.json`);
  for (const value of [JSON.stringify(futureId), '[', JSON.stringify([currentId])]) {
    writeFileSync(path, value);
    assert(revisionFindings().some(issue => issue.code.endsWith('.targetMissing')));
  }
  writeFileSync(path, JSON.stringify(currentId));
  assert.deepEqual(revisionFindings(), []);
  mkdirSync(join(reports, priorId));
  assert(revisionFindings().some(issue => issue.code.endsWith('.targetMissing')));
  rmSync(join(reports, priorId), { recursive: true });
  rmSync(path);
  assert(revisionFindings().some(issue => issue.code.endsWith('.targetMissing')));
});
