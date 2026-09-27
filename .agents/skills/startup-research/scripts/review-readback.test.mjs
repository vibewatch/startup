import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkReviewReadback, prepareReviewReadback } from './review-readback.mjs';
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

test('a schema-successful model exit must pass readback and assembly before completion', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-runner-'));
  const isolatedScripts = join(root, '.agents/skills/startup-research/scripts');
  const runId = '20990101000000-fixture';
  const folder = join(root, 'reports', runId);
  const cache = join(root, '.research-cache', runId);
  const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  try {
    for (const file of ['run-report-finalizer.mjs', 'review-readback.mjs']) {
      mkdirSync(isolatedScripts, { recursive: true });
      copyFileSync(join(scripts, file), join(isolatedScripts, file));
    }
    write(join(isolatedScripts, 'utils.mjs'), `
import {readFileSync} from 'node:fs';
export const EXIT={ok:0,failure:1,notFound:4};
export const FINAL_ARTIFACTS={evidence:{file:'evidence.yaml'},fullReport:{file:'full-report.yaml'},summaryCard:{file:'summary-card.yaml'}};
export const REPORT_META_FILE='report-meta.yaml';
export const getAnalysisArtifacts=()=>[{file:'chapter.yaml'}];
export const isRunId=()=>true;
export const loadWorkflowConfig=()=>({activeResearchProfile:'fast'});
export const normalizeRevision=v=>v;
export const readYaml=p=>JSON.parse(readFileSync(p,'utf8'));
export const researchCacheDir=()=>${JSON.stringify(cache)};
`);
    write(join(isolatedScripts, 'source-quote-checks.mjs'), 'export const checkPrefetchedSourceQuotes=()=>[];');
    write(join(isolatedScripts, 'search-query-checks.mjs'), 'export const checkSearchQueryProvenance=()=>[];export const executedSearchQueries=()=>[];');
    write(join(isolatedScripts, 'contracts/report-artifacts.schema.mjs'), 'export const RevisionSchema={safeParse:data=>({success:true,data})};');
    write(join(isolatedScripts, 'load-chapter-runtime-context.mjs'),
      `console.log(JSON.stringify({policy:{finalizerRouting:{model:'draft',reasoningEffort:'default',escalateTo:'repair'}}}));`);
    write(join(isolatedScripts, 'check-report.mjs'), 'console.log(JSON.stringify({ok:true}));');
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
import {appendFileSync,writeFileSync,readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const prompt=process.argv[process.argv.indexOf('-p')+1];
assert.ok(prompt.includes(${JSON.stringify(reviewPath)}));
const review=JSON.parse(readFileSync(${JSON.stringify(reviewPath)},'utf8'));
assert.ok(review.sourceProof.length>128*1024);
appendFileSync(${JSON.stringify(invocationLog)},JSON.stringify(process.argv.slice(2))+'\\n');
if(process.argv.includes('repair') && process.env.REVIEW_TEST_MODE!=='skip'){
const path=${JSON.stringify(join(folder, 'chapter.yaml'))};
const doc=JSON.parse(readFileSync(path,'utf8'));
doc.claims[0].statement=review.issues[0].exactReplacement;
if(process.env.REVIEW_TEST_MODE==='unrelated')doc.unchanged='Changed';
writeFileSync(path,JSON.stringify(doc));
}
`);
    chmodSync(fake, 0o755);
    for (const mode of ['repair', 'skip', 'unrelated', 'stale-assembly']) {
      for (const [file, doc] of documents()) write(join(folder, file), JSON.stringify(doc));
      for (const file of ['evidence.yaml', 'full-report.yaml', 'summary-card.yaml']) write(join(folder, file), '{}');
      write(invocationLog, '');
      const result = spawnSync(process.execPath, [join(isolatedScripts, 'run-report-finalizer.mjs'),
        '--report-folder', folder, '--review-findings', reviewPath, '--copilot-bin', fake, '--format', 'json'], {
        encoding: 'utf8', env: { ...process.env, STARTUP_FETCH_LOG_PATH: join(cache, '_fetch-log.jsonl'), REVIEW_TEST_MODE: mode },
      });
      assert.equal(result.status, mode === 'repair' ? 0 : 1, result.stderr || result.stdout);
      const output = JSON.parse(result.stdout);
      assert.equal(output.attempts.length, 2);
      assert.equal(output.exactReviewAssignmentCount, 1);
      assert.equal(output.status, mode === 'repair' ? 'completed' : 'failed');
      const invocations = readFileSync(invocationLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      for (const invocation of invocations) {
        const prompt = invocation[invocation.indexOf('-p') + 1];
        assert.ok(prompt.includes(reviewPath));
        assert.ok(Buffer.byteLength(prompt) < 16 * 1024);
        assert.ok(!prompt.includes('SOURCE-CONTEXT'));
      }
      const feedback = join(cache, 'finalizer-acceptance-attempt-1.json');
      assert.ok(invocations[1][invocations[1].indexOf('-p') + 1].includes(feedback));
      assert.match(readFileSync(feedback, 'utf8'), /reviewReadbackMismatch/);
      assert.equal(output.attempts[1].previousFailuresPath, feedback);
      if (mode === 'stale-assembly') assert.ok(output.reportCheck.reviewIssues.some((issue) => issue.code === 'reviewAssemblyMismatch'));
      if (mode === 'unrelated') assert.ok(output.reportCheck.reviewIssues.some((issue) => issue.path === 'chapter.yaml:unchanged'));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
