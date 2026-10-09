import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkReviewReadback, prepareReviewReadback } from './review-readback.mjs';
import { loadRefreshContext, recordRefreshReasonReview, REFRESH_REASON_REVIEW_FILE } from './refresh-context.mjs';
import { getAnalysisArtifacts, loadWorkflowConfig } from './utils.mjs';
import { CARD_CONFIDENCES, CARD_RECOMMENDATIONS, CARD_RISK_RATINGS, CARD_VALUATION_STANCES } from './validation-catalog.mjs';

const scripts = resolve('.agents/skills/startup-research/scripts');
const documents = () => new Map([
  ['chapter.yaml', { claims: [{ statement: 'Estimated 60', refs: ['C1', 'C2'] }], unchanged: 'Keep' }],
  ['report-meta.yaml', { score: 5 }],
]);
const finding = (patch = {}) => ({
  path: 'chapter.yaml:claims[0].statement', tokens: ['claims', 0, 'statement'],
  expectedBefore: 'Estimated 60', exactReplacement: 'Estimated target 60, not actual enrollment', ...patch,
});

test('exact review readback catches missing values and unrelated edits without mutating its baseline', () => {
  const original = documents();
  const baseline = structuredClone(original);
  const readback = prepareReviewReadback([finding()], original);
  assert.deepEqual(original, baseline);
  assert.equal(checkReviewReadback(readback, (file) => original.get(file))[0].path, finding().path);
  original.get('chapter.yaml').claims[0].statement = finding().exactReplacement;
  assert.deepEqual(checkReviewReadback(readback, (file) => original.get(file)), []);
  original.get('chapter.yaml').claims[0].refs.reverse();
  original.get('report-meta.yaml').score = 9;
  original.get('chapter.yaml').extra = 'Unapproved';
  const issues = checkReviewReadback(readback, (file) => original.get(file));
  assert.deepEqual(issues.map((issue) => issue.path), [
    'chapter.yaml:claims[0].refs', 'chapter.yaml:extra', 'report-meta.yaml:score',
  ]);
  assert.deepEqual(issues[0].expectedValue, ['C1', 'C2']);
  assert.equal(issues[1].removeField, true);
  assert.ok(checkReviewReadback(readback, () => { throw new Error('unreadable YAML'); })
    .every((issue) => issue.code === 'reviewReadbackUnavailable'));
  assert.equal(prepareReviewReadback([{ path: 'chapter.yaml:claims', message: 'Legacy', fix: 'Review' }], original), null);
  assert.deepEqual(checkReviewReadback(null, () => assert.fail('legacy review must not read snapshots')), []);
  const shared = { statement: 'Before' };
  const aliased = new Map([['chapter.yaml', { first: shared, second: shared }]]);
  const isolated = prepareReviewReadback([finding({ path: 'chapter.yaml:first.statement',
    tokens: ['first', 'statement'], expectedBefore: 'Before', exactReplacement: 'After' })], aliased);
  assert.deepEqual(isolated.expected.get('chapter.yaml'), { first: { statement: 'After' }, second: { statement: 'Before' } });
});

test('exact review preflight rejects stale, partial, ambiguous and invalid targets', () => {
  for (const patch of [
    { expectedBefore: 'Stale' }, { tokens: [] }, { tokens: ['claims', -1] },
    { tokens: ['claims', 0.5] }, { tokens: ['claims', '0', 'statement'] },
    { tokens: ['missing'], path: 'chapter.yaml:missing' },
    { tokens: ['toString'], path: 'chapter.yaml:toString' },
    { path: 'chapter.yaml:claims[1].statement' }, { path: '../chapter.yaml:claims[0].statement' },
  ]) assert.throws(() => prepareReviewReadback([finding(patch)], documents()));
  for (const field of ['tokens', 'expectedBefore', 'exactReplacement']) {
    const partial = finding();
    delete partial[field];
    assert.throws(() => prepareReviewReadback([partial], documents()));
  }
  assert.throws(() => prepareReviewReadback([finding(), finding()], documents()), /overlapping/);
  assert.throws(() => prepareReviewReadback([finding(), finding({
    path: 'chapter.yaml:claims', tokens: ['claims'], expectedBefore: documents().get('chapter.yaml').claims,
  })], documents()), /overlapping/);
  const meta = new Map([['report-meta.yaml', { nullable: null, value: 0, flag: false }]]);
  for (const [key, before, after] of [['nullable', null, 'Known'], ['value', 0, 10], ['flag', false, true]]) {
    const state = prepareReviewReadback([finding({ path: `report-meta.yaml:${key}`, tokens: [key],
      expectedBefore: before, exactReplacement: after })], meta);
    assert.deepEqual(checkReviewReadback(state, (file) => state.expected.get(file)), []);
  }
});

test('refresh reason reviews preserve original intent and reject stale or conflicting records', () => {
  const cache = mkdtempSync(join(tmpdir(), 'refresh-reason-'));
  const runId = '20990102000000-fixture';
  const original = {
    mode: 'refresh', newRunId: runId, refreshOfRunId: '20990101000000-fixture',
    refreshReason: 'Original creation instructions.', previousReport: { summary: 'Unchanged historical context' },
  };
  const contextPath = join(cache, 'refresh-context.yaml');
  const reviewPath = join(cache, REFRESH_REASON_REVIEW_FILE);
  const bytes = Buffer.from(`${JSON.stringify(original)}\n`);
  try {
    assert.equal(loadRefreshContext(runId, cache).context, null);
    assert.throws(() => recordRefreshReasonReview(runId, 'Reviewed public description.', cache), /authentic/);
    writeFileSync(contextPath, bytes);
    assert.deepEqual(loadRefreshContext(runId, cache).context, original);
    for (const invalid of ['', ' ', original.refreshReason]) {
      assert.throws(() => recordRefreshReasonReview(runId, invalid, cache));
    }
    const reviewedReason = 'Corrected funding qualifications and historical source attribution.';
    const review = recordRefreshReasonReview(runId, reviewedReason, cache);
    const reviewBytes = readFileSync(reviewPath);
    const state = loadRefreshContext(runId, cache);
    assert.deepEqual(state.originalContext, original);
    assert.deepEqual(state.context, { ...original, refreshReason: reviewedReason });
    assert.deepEqual(recordRefreshReasonReview(runId, reviewedReason, cache), review);
    assert.deepEqual(readFileSync(reviewPath), reviewBytes);
    assert.throws(() => recordRefreshReasonReview(runId, 'Another correction.', cache), /overwrite/);
    assert.deepEqual(readFileSync(contextPath), bytes);
    for (const patch of [
      { schemaVersion: 'unknown' }, { runId: '20990103000000-wrong' },
      { refreshOfRunId: '20980101000000-wrong' }, { contextSha256: 'changed' },
      { originalReason: 'Fabricated original intent' }, { reviewedReason: ' ' },
      { reviewedReason: original.refreshReason }, { reviewedAt: 'not a date' },
    ]) {
      writeFileSync(reviewPath, JSON.stringify({ ...review, ...patch }));
      assert.throws(() => loadRefreshContext(runId, cache), /Invalid or stale/);
      assert.throws(() => recordRefreshReasonReview(runId, reviewedReason, cache));
    }
    writeFileSync(reviewPath, reviewBytes);
    writeFileSync(contextPath, Buffer.concat([bytes, Buffer.from('\n')]));
    assert.throws(() => loadRefreshContext(runId, cache), /stale/);
    rmSync(contextPath);
    assert.throws(() => loadRefreshContext(runId, cache), /original refresh-context/);
    writeFileSync(contextPath, bytes);
    assert.deepEqual(loadRefreshContext(runId, cache).originalContext, original);
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

test('link-refresh reviews only the current reason, preserves provenance, and synchronizes Chinese revisions', () => {
  const root = mkdtempSync(join(tmpdir(), 'refresh-reason-link-'));
  const isolatedScripts = join(root, '.agents/skills/startup-research/scripts');
  const runId = '20990102000000-fixture';
  const previousId = '20990101000000-fixture';
  const folder = join(root, 'reports', runId);
  const previous = join(root, 'reports', previousId);
  const cache = join(root, '.research-cache', runId);
  const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  const run = (...args) => spawnSync(process.execPath,
    [join(isolatedScripts, 'link-refresh.mjs'), folder, ...args], { encoding: 'utf8' });
  try {
    mkdirSync(isolatedScripts, { recursive: true });
    for (const file of ['link-refresh.mjs', 'refresh-context.mjs', 'refresh-readback.mjs', 'report-retention.mjs']) {
      copyFileSync(join(scripts, file), join(isolatedScripts, file));
    }
    write(join(isolatedScripts, 'utils.mjs'), `
import {existsSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
export const EXIT={ok:0,failure:1,notFound:4,alreadyExists:2};
export const SUMMARY_CARD_FILE='summary-card.yaml';
export const REPORT_META_FILE='report-meta.yaml';
export const FINAL_ARTIFACTS={summaryCard:{file:SUMMARY_CARD_FILE},fullReport:{file:'full-report.yaml'}};
export const reportsDir=${JSON.stringify(join(root, 'reports'))};
export const researchCacheDir=id=>join(${JSON.stringify(join(root, '.research-cache'))},id);
export const isRunId=id=>typeof id==='string'&&/^\\d{14}-[a-z0-9-]+$/.test(id);
export const hasText=v=>typeof v==='string'&&v.trim().length>0;
export const normalizeCompanyName=v=>String(v??'').toLowerCase();
export const normalizeDomain=v=>String(v??'').toLowerCase();
export const normalizeRevision=v=>v??{};
export const readYaml=p=>JSON.parse(readFileSync(p,'utf8'));
export const writeYaml=(p,v)=>writeFileSync(p,JSON.stringify(v));
export const tryReadYaml=p=>existsSync(p)?{ok:true,value:readYaml(p)}:{ok:false};
export const listDirs=p=>readdirSync(p);
export const isFinalizedReportFolder=p=>['report-meta.yaml','summary-card.yaml','full-report.yaml'].every(f=>existsSync(join(p,f)));
`);
    write(join(isolatedScripts, 'contracts/report-artifacts.schema.mjs'),
      'export const RevisionSchema={safeParse:data=>({success:!!data,data})};');
    const synchronize = (files, source) => `
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const folder=process.argv[2];
const revision=JSON.parse(readFileSync(join(folder,${JSON.stringify(source)}),'utf8')).revision;
for(const file of ${JSON.stringify(files)}){
const path=join(folder,file);if(!existsSync(path))continue;
const doc=JSON.parse(readFileSync(path,'utf8'));doc.revision=revision;
writeFileSync(path,JSON.stringify(doc));
}`;
    write(join(isolatedScripts, 'build-report.mjs'),
      synchronize(['summary-card.yaml', 'full-report.yaml'], 'report-meta.yaml'));
    write(join(root, '.agents/skills/translate-zh/scripts/sync-preserved-fields.mjs'),
      synchronize(['summary-card.zh.yaml', 'full-report.zh.yaml'], 'summary-card.yaml'));
    write(join(isolatedScripts, 'check-report.mjs'), `
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {join} from 'node:path';
const folder=process.argv[2];
const docs=['report-meta.yaml','summary-card.yaml','full-report.yaml','summary-card.zh.yaml','full-report.zh.yaml']
.map(f=>JSON.parse(readFileSync(join(folder,f),'utf8')));
assert.ok(docs.every(d=>JSON.stringify(d.revision)===JSON.stringify(docs[0].revision)));
`);
    const currentRevision = { status: 'current', refreshOfRunId: previousId, supersededByRunId: null, refreshReason: 'Original creation instructions.' };
    const previousRevision = { status: 'superseded', refreshOfRunId: '20980101000000-fixture',
      supersededByRunId: runId, refreshReason: 'Earlier published refresh reason.' };
    const originals = new Map();
    for (const [directory, revision] of [[folder, currentRevision], [previous, previousRevision]]) {
      for (const file of ['report-meta.yaml', 'summary-card.yaml', 'full-report.yaml', 'summary-card.zh.yaml', 'full-report.zh.yaml']) {
        const path = join(directory, file);
        const bytes = Buffer.from(JSON.stringify({ company: { name: 'Fixture' }, revision, prose: `Preserve ${file}` }));
        write(path, bytes);
        originals.set(path, bytes);
      }
    }
    const contextPath = join(cache, 'refresh-context.yaml');
    const originalContext = Buffer.from(JSON.stringify({
      mode: 'refresh', newRunId: runId, refreshOfRunId: previousId, refreshReason: currentRevision.refreshReason,
      previousReport: { preserved: true },
    }));
    write(contextPath, originalContext);
    const reason = 'Corrected financing status and source qualifications.';
    for (const invalid of [
      ['--review-refresh-reason'], ['--review-refresh-reason', '--prepare-current'],
      ['--review-refresh-reason', reason, '--prepare-current'],
      ['--review-refresh-reason', reason, '--refresh-reason', reason],
    ]) assert.equal(run(...invalid).status, 1);
    const metaPath = join(folder, 'report-meta.yaml');
    for (const patch of [
      { status: 'unknown' }, { status: 'superseded', supersededByRunId: '20990103000000-fixture' },
      { supersededByRunId: '20990103000000-fixture' }, { refreshReason: 'Unapproved drift' },
    ]) {
      const meta = JSON.parse(originals.get(metaPath));
      meta.revision = { ...meta.revision, ...patch };
      writeFileSync(metaPath, JSON.stringify(meta));
      assert.equal(run('--review-refresh-reason', reason).status, 1);
      assert.equal(existsSync(join(cache, REFRESH_REASON_REVIEW_FILE)), false);
    }
    writeFileSync(metaPath, originals.get(metaPath));
    const reviewed = run('--review-refresh-reason', reason);
    assert.equal(reviewed.status, 0, reviewed.stderr || reviewed.stdout);
    const reviewPath = join(cache, REFRESH_REASON_REVIEW_FILE);
    const reviewBytes = readFileSync(reviewPath);
    for (const [path, bytes] of originals) {
      if (path.startsWith(`${previous}/`)) assert.deepEqual(readFileSync(path), bytes);
      else {
        const expected = JSON.parse(bytes);
        expected.revision.refreshReason = reason;
        assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), expected);
      }
    }
    assert.deepEqual(readFileSync(contextPath), originalContext);
    assert.equal(run('--review-refresh-reason', reason).status, 0);
    assert.deepEqual(readFileSync(reviewPath), reviewBytes);
    assert.equal(run('--review-refresh-reason', 'Different reason.').status, 1);
    assert.equal(run('--refresh-reason', currentRevision.refreshReason).status, 1);
    const stalePath = join(folder, 'full-report.zh.yaml');
    const stale = JSON.parse(readFileSync(stalePath, 'utf8'));
    stale.revision = currentRevision;
    writeFileSync(stalePath, JSON.stringify(stale));
    const resumed = run();
    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
    assert.equal(JSON.parse(readFileSync(stalePath, 'utf8')).revision.refreshReason, reason);
    assert.deepEqual(readFileSync(contextPath), originalContext);
    assert.deepEqual(readFileSync(reviewPath), reviewBytes);
    for (const [path, bytes] of originals) {
      if (path.startsWith(`${previous}/`)) assert.deepEqual(readFileSync(path), bytes);
    }
    const redirectPath = join(root, 'reports/.redirects', `${previousId}.json`);
    write(redirectPath, JSON.stringify(runId));
    rmSync(previous, { recursive: true });
    for (const args of [[], ['--prepare-current'], ['--review-refresh-reason', reason]]) {
      const replay = run(...args);
      assert.equal(replay.status, 0, replay.stderr || replay.stdout);
      assert(!existsSync(previous), 'idempotent refresh must not recreate retired English or Chinese');
      assert.deepEqual(readFileSync(contextPath), originalContext);
      assert.deepEqual(readFileSync(reviewPath), reviewBytes);
    }
    writeFileSync(redirectPath, JSON.stringify('20990103000000-fixture'));
    assert.equal(run().status, 1, 'a missing predecessor needs this exact retirement relationship');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('canonical builder checks detect stale artifacts without rewriting them', () => {
  const folder = mkdtempSync(join(tmpdir(), 'review-assembly-'));
  const write = (file, value) => writeFileSync(join(folder, file), JSON.stringify(value));
  const run = (script, args = []) => spawnSync(process.execPath,
    [join(scripts, script), folder, ...args, '--format', 'json'], { encoding: 'utf8' });
  try {
    const roster = getAnalysisArtifacts(loadWorkflowConfig());
    for (const chapter of roster) write(chapter.file, {
      schemaVersion: 'report-v2', artifact: chapter.artifact, slug: 'fixture', runDate: '2099-01-01',
      company: { name: 'Fixture' }, chapter: { number: chapter.order, title: chapter.key, summary: 'Fixture' },
      sections: [], tables: [], figures: [],
      localEvidence: { sources: [], claims: [{ id: `C${chapter.letter}001`, statement: chapter.key, sourceRefs: [] }] },
    });
    write('report-meta.yaml', {
      slug: 'fixture', runDate: '2099-01-01', company: { name: 'Fixture' },
      companyProfile: { summary: 'Fixture', productSummary: 'Fixture' },
      summary: { headline: 'Fixture', overallScore: 5, recommendation: [...CARD_RECOMMENDATIONS][0],
        confidence: [...CARD_CONFIDENCES][0], riskRating: [...CARD_RISK_RATINGS][0], valuationStance: [...CARD_VALUATION_STANCES][0],
        keyMetrics: Object.fromEntries(['valuationUsdM', 'revenueRunRateUsdM', 'arrUsdM', 'revenueGrowthYoYPct',
          'grossMarginPct', 'nrrPct', 'totalRaisedUsdM', 'customerCount', 'headcount'].map((key) => [key, null])),
        topStrengths: ['Fixture'], topRisks: ['Fixture'], unresolvedGaps: [] },
    });
    for (const script of ['build-evidence-ledger.mjs', 'build-report.mjs']) {
      const built = run(script);
      assert.equal(built.status, 0, built.stdout || built.stderr);
    }
    for (const [script, file] of [
      ['build-evidence-ledger.mjs', 'evidence.yaml'],
      ['build-report.mjs', 'full-report.yaml'],
      ['build-report.mjs', 'summary-card.yaml'],
    ]) {
      const path = join(folder, file);
      const original = readFileSync(path);
      assert.equal(run(script, ['--check']).status, 0);
      assert.deepEqual(readFileSync(path), original);
      writeFileSync(path, `${original.toString('utf8')}\nunapproved: true\n`);
      const stale = readFileSync(path);
      const rejected = run(script, ['--check']);
      assert.equal(rejected.status, 1);
      assert.match(rejected.stdout, /assemblyMismatch/);
      assert.deepEqual(readFileSync(path), stale, '--check must never repair the artifact');
      writeFileSync(path, original);
    }
    assert.equal(run('build-report.mjs', ['--check', '--dry-run']).status, 1);
    assert.equal(run('build-report.mjs', ['--dry-run']).status, 0);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a schema-successful model exit must pass strict chapters, readback and assembly before completion', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-runner-'));
  const isolatedScripts = join(root, '.agents/skills/startup-research/scripts');
  const runId = '20990101000000-fixture';
  const folder = join(root, 'reports', runId);
  const cache = join(root, '.research-cache', runId);
  const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  try {
    for (const file of ['run-report-finalizer.mjs', 'review-readback.mjs', 'refresh-readback.mjs', 'report-retention.mjs']) {
      mkdirSync(isolatedScripts, { recursive: true });
      copyFileSync(join(scripts, file), join(isolatedScripts, file));
    }
    write(join(isolatedScripts, 'utils.mjs'), `
import {readFileSync} from 'node:fs';
export const EXIT={ok:0,failure:1,notFound:4};
export const FINAL_ARTIFACTS={evidence:{file:'evidence.yaml'},fullReport:{file:'full-report.yaml'},summaryCard:{file:'summary-card.yaml'}};
export const REPORT_META_FILE='report-meta.yaml';
export const SUMMARY_CARD_FILE='summary-card.yaml';
export const isFinalizedReportFolder=()=>false;
export const normalizeCompanyName=value=>String(value??'');
export const normalizeDomain=value=>String(value??'');
export const getAnalysisArtifacts=()=>[{file:'chapter.yaml'},{file:'second.yaml'}];
export const hasText=value=>typeof value==='string'&&value.trim().length>0;
export const isRunId=()=>true;
export const loadWorkflowConfig=()=>({activeResearchProfile:'fast'});
export const normalizeRevision=v=>v;
export const readYaml=p=>JSON.parse(readFileSync(p,'utf8'));
export const researchCacheDir=()=>${JSON.stringify(cache)};
export const reportsDir=${JSON.stringify(join(root, 'reports'))};
`);
    write(join(isolatedScripts, 'source-quote-checks.mjs'), 'export const checkPrefetchedSourceQuotes=()=>[];');
    write(join(isolatedScripts, 'search-query-checks.mjs'), 'export const checkSearchQueryProvenance=()=>[];export const executedSearchQueries=()=>[];');
    write(join(isolatedScripts, 'contracts/report-artifacts.schema.mjs'), 'export const RevisionSchema={safeParse:data=>({success:true,data})};');
    write(join(isolatedScripts, 'load-chapter-runtime-context.mjs'),
      `console.log(JSON.stringify({policy:{finalizerRouting:{model:'draft',reasoningEffort:'default',escalateTo:'repair'}}}));`);
    write(join(isolatedScripts, 'check-report.mjs'), 'console.log(JSON.stringify({ok:true}));');
    const strictLog = join(cache, 'strict-checks.jsonl');
    const repairedGate = join(cache, 'strict-repaired');
    write(join(isolatedScripts, 'check-chapter.mjs'), `
import assert from 'node:assert/strict';
import {appendFileSync,existsSync} from 'node:fs';
assert.deepEqual(process.argv.slice(2),[${JSON.stringify(folder)},process.argv[3],'--strict','--format','json']);
assert.equal(process.env.STARTUP_FETCH_LOG_PATH,${JSON.stringify(join(cache, '_fetch-log.jsonl'))});
appendFileSync(${JSON.stringify(strictLog)},JSON.stringify(process.argv.slice(2))+'\\n');
const mode=process.env.REVIEW_TEST_MODE;
const fail=process.argv[3]==='second.yaml' && mode.startsWith('strict-')
  && !(mode==='strict-repaired' && existsSync(${JSON.stringify(repairedGate)}));
if(fail && mode==='strict-crash'){console.error('strict validator unavailable');process.exit(2);}
if(fail && mode==='strict-malformed'){console.log('not a validation envelope');process.exit(0);}
const hard=mode==='strict-error';
console.log(JSON.stringify({ok:!fail || mode==='strict-true-nonzero',
  issues:fail && hard?[{dimension:'claimRefs',message:'Missing claim',fix:'Repair the claim reference.'}]:[],
  warnings:fail && !hard?[{dimension:'figureType',message:'Intentional substitution needs acknowledgement',
    fix:'Review the figure substitution before acknowledging it.'}]:[],
  summary:{strict:true,failedDimensions:fail && hard?['claimRefs']:[],
    unackedWarningDimensions:fail && !hard?['figureType']:[]}}));
process.exit(fail && mode!=='strict-false-zero'?1:0);
`);
    for (const file of ['build-report.mjs', 'build-evidence-ledger.mjs']) write(join(isolatedScripts, file),
      `if(!process.argv.includes('--check'))throw new Error('expected read-only check');process.exit(process.env.REVIEW_TEST_MODE==='stale-assembly'?1:0);`);
    for (const file of ['worker-results.json', 'search-bundle.json', '_fetch-log.jsonl']) write(join(cache, file), '{}');
    const reviewPath = join(cache, 'review.json');
    const largeSourceContext = 'SOURCE-CONTEXT '.repeat(20000);
    write(reviewPath, JSON.stringify({ runId, sourceProof: largeSourceContext,
      issues: [{ ...finding(), message: 'Clinical target correction', fix: 'Use exact replacement.' }] }));
    assert.ok(readFileSync(reviewPath).length > 128 * 1024);
    const fake = join(cache, 'fake-copilot.mjs');
    const invocationLog = join(cache, 'invocations.jsonl');
    write(fake, `#!/usr/bin/env node
import {appendFileSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import assert from 'node:assert/strict';
const prompt=process.argv[process.argv.indexOf('-p')+1];
assert.ok(prompt.includes(${JSON.stringify(reviewPath)}));
const review=JSON.parse(readFileSync(${JSON.stringify(reviewPath)},'utf8'));
assert.ok(review.sourceProof.length>128*1024);
appendFileSync(${JSON.stringify(invocationLog)},JSON.stringify(process.argv.slice(2))+'\\n');
if((process.argv.includes('repair') || process.env.REVIEW_TEST_MODE.startsWith('strict-'))
    && process.env.REVIEW_TEST_MODE!=='skip'){
const path=${JSON.stringify(join(folder, 'chapter.yaml'))};
const doc=JSON.parse(readFileSync(path,'utf8'));
doc.claims[0].statement=review.issues[0].exactReplacement;
if(process.env.REVIEW_TEST_MODE==='unrelated')doc.unchanged='Changed';
writeFileSync(path,JSON.stringify(doc));
}
if(process.argv.includes('repair') && process.env.REVIEW_TEST_MODE==='strict-repaired'){
writeFileSync(${JSON.stringify(repairedGate)},'repaired');
}
if(process.env.REVIEW_TEST_MODE==='missing-chapter'){
rmSync(${JSON.stringify(join(folder, 'second.yaml'))},{force:true});
}
`);
    chmodSync(fake, 0o755);
    for (const mode of ['strict-warning', 'repair', 'skip', 'unrelated', 'stale-assembly',
      'strict-error', 'strict-crash', 'strict-malformed',
      'strict-false-zero', 'strict-true-nonzero', 'strict-repaired', 'missing-chapter']) {
      for (const [file, doc] of documents()) write(join(folder, file), JSON.stringify(doc));
      write(join(folder, 'second.yaml'), '{}');
      for (const file of ['evidence.yaml', 'full-report.yaml', 'summary-card.yaml']) write(join(folder, file), '{}');
      write(invocationLog, '');
      write(strictLog, '');
      rmSync(repairedGate, { force: true });
      const result = spawnSync(process.execPath, [join(isolatedScripts, 'run-report-finalizer.mjs'),
        '--report-folder', folder, '--review-findings', reviewPath, '--copilot-bin', fake, '--format', 'json'], {
        encoding: 'utf8', env: { ...process.env, STARTUP_FETCH_LOG_PATH: join(cache, '_fetch-log.jsonl'), REVIEW_TEST_MODE: mode },
      });
      const succeeds = mode === 'repair' || mode === 'strict-repaired';
      assert.equal(result.status, succeeds ? 0 : 1, `${mode}: ${result.stderr || result.stdout}`);
      const output = JSON.parse(result.stdout);
      assert.equal(output.attempts.length, 2);
      assert.equal(output.exactReviewAssignmentCount, 1);
      assert.equal(output.status, succeeds ? 'completed' : 'failed');
      const invocations = readFileSync(invocationLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      for (const invocation of invocations) {
        const prompt = invocation[invocation.indexOf('-p') + 1];
        assert.ok(prompt.includes(reviewPath));
        assert.ok(Buffer.byteLength(prompt) < 16 * 1024);
        assert.ok(!prompt.includes('SOURCE-CONTEXT'));
      }
      const feedback = join(cache, 'finalizer-acceptance-attempt-1.json');
      assert.ok(invocations[1][invocations[1].indexOf('-p') + 1].includes(feedback));
      if (mode.startsWith('strict-')) {
        const diagnostic = JSON.parse(readFileSync(feedback, 'utf8'));
        assert.deepEqual(diagnostic.reportCheck.reviewIssues, []);
        assert.equal(diagnostic.reportCheck.chapterChecks[1].ok, false);
        assert.equal(diagnostic.reportCheck.chapterChecks[1].file, 'second.yaml');
      } else {
        assert.match(readFileSync(feedback, 'utf8'), /reviewReadbackMismatch/);
      }
      assert.equal(output.attempts[1].previousFailuresPath, feedback);
      if (mode === 'missing-chapter') {
        assert.deepEqual(output.missingFiles, ['second.yaml']);
        assert.equal(output.reportCheck.chapterChecks.length, 2);
        assert.equal(output.reportCheck.ok, false);
        assert.match(output.reportCheck.error, /Missing artifacts: second\.yaml/u);
      }
      assert.deepEqual(readFileSync(strictLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line)[1]),
        ['chapter.yaml', 'second.yaml', 'chapter.yaml', 'second.yaml']);
      if (mode === 'strict-warning') {
        const strict = output.reportCheck.chapterChecks[1];
        assert.equal(strict.exitCode, 1);
        assert.deepEqual(strict.validation.issues, []);
        assert.deepEqual(strict.validation.summary.unackedWarningDimensions, ['figureType']);
        assert.match(strict.validation.warnings[0].fix, /Review the figure substitution/);
      }
      if (mode === 'strict-crash') assert.match(output.reportCheck.error, /strict validator unavailable/);
      if (mode === 'strict-malformed') assert.match(output.reportCheck.error, /invalid JSON/);
      if (mode === 'strict-repaired') assert.ok(output.reportCheck.chapterChecks.every((check) => check.ok));
      if (mode === 'stale-assembly') assert.ok(output.reportCheck.reviewIssues.some((issue) => issue.code === 'reviewAssemblyMismatch'));
      if (mode === 'unrelated') assert.ok(output.reportCheck.reviewIssues.some((issue) => issue.path === 'chapter.yaml:unchanged'));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
