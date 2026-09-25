#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkPairQuality, editorialQualityImproved } from './check-translation-quality.mjs';
import { untranslatedMessage } from './check-translation.mjs';

function fullReport(subtitle) {
  return {
    schemaVersion: 'report-v2',
    artifact: 'full-report',
    subtitle,
  };
}

const source = fullReport('Approximately $10M revenue in 2025 is not yet audited.');
const clean = fullReport('2025 年收入约 $10M，尚未经审计。');
const changedMetric = fullReport('2025 年收入约 $11M，尚未经审计。');
const translationese = fullReport('对于投资者而言，2025 年收入约 $10M，尚未经审计。');
const strictTranslationese = fullReport('2025 年收入约 $10M，这表明公司尚未经审计。');
const suffixBoundarySource = fullReport('Founded in 2016, the baseline includes 170M members.');
const suffixBoundaryClean = fullReport('公司成立于 2016 年，基准口径覆盖 170M 名会员。');
const nominalClaimSource = fullReport('The reviewed insurance data provides an adversarial baseline for claims modeling.');
const assertionSource = fullReport('The company claims its new system improves the operational baseline for claims modeling.');
const fiscalYearSource = fullReport('Cumulative revenue milestones are due by the end of fiscal year 2029.');
const negativeExamples = [
  ['No public GMV, conversion, or basket-size uplift is disclosed.', '公开资料未披露 GMV、转化率或客单价提升。', '公开资料披露了 GMV、转化率和客单价提升。'],
  ['The contract provides no public renewal or customer spending data.', '合同的续约与客户支出数据未公开。', '合同的续约与客户支出数据已公开。'],
  ['Beta access only; pricing unknown; reliability unproven at scale.', '仅限 beta 接入；定价未知；规模化可靠性未验证。', '仅限 beta 接入；定价未知；规模化可靠性已验证。'],
  ['It looks like a future leader, but not yet like a company ready for the public markets.', '公司看似有望成为未来的领头羊，但还不像已做好上市准备。', '公司看似有望成为未来的领头羊，也已做好上市准备。'],
  ['Small teams do not yet need a full product-development system of record.', '小团队尚不需要完整的产品开发记录系统。', '小团队需要完整的产品开发记录系统。'],
  ['The evidence supports the thesis at the workflow level, but not yet at the scale of a fully underwritten category leader.', '证据支持工作流需求，但还没到能充分支撑品类龙头投资判断的程度。', '证据支持工作流需求，也充分支撑了品类龙头的投资判断。'],
  ['The homepage highlights enterprise compliance. Those claims alone do not prove broad enterprise penetration.', '官网强调企业合规；这些表述本身不能证明公司已广泛渗透企业市场。', '企业合规水平很高，但这本身不能证明公司已广泛渗透企业市场。'],
];
const multiplierSource = fullReport('Harvey pricing is 5-10x Spellbook and 2-5x CoCounsel.');
const patentSource = fullReport('Trademark search analysis, patent claim drafting, freedom-to-operate research');
const patentAssertionSource = fullReport('The company claims its new product improves patent claim drafting.');

const checks = [
  [
    checkPairQuality(source, clean, { strictEditor: true }).length === 0,
    'strict editor rejected a faithful native translation',
  ],
  [
    checkPairQuality(source, changedMetric, { strictEditor: true })
      .some((issue) => issue.code === 'metric-preservation'),
    'strict editor did not reject a changed metric',
  ],
  [
    checkPairQuality(source, translationese, { strictEditor: true })
      .some((issue) => issue.code === 'translationese'),
    'strict editor did not reject translationese',
  ],
  [
    checkPairQuality(source, strictTranslationese, { strictEditor: true })
      .filter((issue) => issue.code === 'editor-translationese').length === 1,
    'strict editor duplicated one translationese finding',
  ],
  [
    checkPairQuality(suffixBoundarySource, suffixBoundaryClean, { strictEditor: true }).length === 0,
    'metric matcher consumed the first letter of a following word as a scale suffix',
  ],
  [
    checkPairQuality(nominalClaimSource, fullReport('已审查的保险数据为理赔建模提供对照基线。')).length === 0,
    'insurance claims modeling was mistaken for an attributed assertion',
  ],
  [
    checkPairQuality(assertionSource, fullReport('新系统改善了理赔建模的运营基准。'))
      .some((issue) => issue.code === 'hedge-preservation')
      && checkPairQuality(assertionSource, fullReport('公司称新系统改善了理赔建模的运营基准。')).length === 0,
    'nominal claims exclusion hid an actual company assertion',
  ],
  [
    checkPairQuality(patentSource, fullReport('商标检索分析、专利权利要求起草、自由实施检索')).length === 0
      && checkPairQuality(patentAssertionSource, fullReport('新产品改善了专利权利要求起草。'))
        .some((issue) => issue.code === 'hedge-preservation'),
    'patent terminology must not require attribution or hide a separate assertion',
  ],
  [
    checkPairQuality(multiplierSource, fullReport('Harvey 定价是 Spellbook 的 5-10 倍、CoCounsel 的 2–5 倍。'), { strictEditor: true }).length === 0
      && checkPairQuality(fullReport('Revenue is 4× the prior year.'), fullReport('收入是上年的 4 倍。'), { strictEditor: true }).length === 0
      && checkPairQuality(fullReport('The valuation is 15xARR.'), fullReport('估值为 15x ARR。'), { strictEditor: true }).length === 0,
    'equivalent multiplier notation was rejected',
  ],
  ...[
    'Harvey 定价是 Spellbook 的 6-10 倍、CoCounsel 的 2-5 倍。',
    'Harvey 定价是 Spellbook 的 5-11 倍、CoCounsel 的 2-5 倍。',
    'Harvey 定价是 Spellbook 的 5-10%、CoCounsel 的 2-5 倍。',
    'Harvey 定价是 Spellbook 的 5-10 倍。',
  ].map((zh) => [
    checkPairQuality(multiplierSource, fullReport(zh), { strictEditor: true })
      .some((issue) => issue.code === 'metric-preservation'),
    `multiplier comparison missed a changed endpoint, unit, or omitted range: ${zh}`,
  ]),
  [
    checkPairQuality(fiscalYearSource, fullReport('累计收入里程碑须在 FY2029 财年底前完成。')).length === 0
      && checkPairQuality(fiscalYearSource, fullReport('累计收入里程碑须在 FY2030 财年底前完成。'))
        .some((issue) => issue.code === 'year-preservation')
      && checkPairQuality(fullReport('Complete by FY2029.'), fullReport('完成期限未披露。'))
        .some((issue) => issue.code === 'year-preservation'),
    'fiscal-year matching must accept FY prefixes without hiding changed or missing years',
  ],
  [
    checkPairQuality(fullReport('groq.com/pricing (official)'), fullReport('groq.com/pricing（官方定价页）')).length === 0
      && checkPairQuality(fullReport('https://example.com/revenue (official)'), fullReport('https://example.com/revenue（官方页面）')).length === 0
      && checkPairQuality(fullReport('Pricing at groq.com/pricing'), fullReport('groq.com/pricing 的 pricing'))
        .some((issue) => issue.code === 'descriptor-leak')
      && checkPairQuality(fullReport('Pricing at groq.com/pricing'), fullReport('groq.com/pricing，pricing 未译'))
        .some((issue) => issue.code === 'descriptor-leak'),
    'URL paths must be preserved without hiding untranslated descriptors outside URLs',
  ],
  [
    checkPairQuality(
      fullReport('Commercial conversion remains unproven, and the company has not yet published audited financials.'),
      fullReport('商业转化尚未验证，公司还没有发布经审计财务。'),
    ).length === 0
      && checkPairQuality(
        fullReport('No public evidence was found to confirm certification or any independent security audit.'),
        fullReport('未发现公开证据确认认证或任何独立安全审计。'),
      ).length === 0
      && checkPairQuality(
        fullReport('Commercial conversion remains unproven, and the company has not yet published audited financials.'),
        fullReport('商业转化已获验证，公司已经发布经审计财务。'),
      ).filter((issue) => issue.code === 'hedge-preservation').length === 2,
    'faithful negative qualifiers must pass while reversed certainty must fail',
  ],
  [
    untranslatedMessage('Tobi Lütke', 'Tobi Lütke') === null
      && untranslatedMessage('Andreessen Horowitz (a16z)', 'Andreessen Horowitz (a16z)') === null
      && untranslatedMessage('Gao Jiyang (高继扬)', 'Gao Jiyang (高继扬)') === null
      && untranslatedMessage('Physical Intelligence (π0)', 'Physical Intelligence (π0)') === null
      && untranslatedMessage('Lee Seung-gun (SG Lee / 이승건)', 'Lee Seung-gun（SG Lee / 이승건）') === null
      && untranslatedMessage('16λ DWDM, 112G PAM4', '16λ DWDM、112G PAM4') === null,
    'strict structural check rejected a Latin proper noun',
  ],
  [
    untranslatedMessage('Global retail sample', 'Global retail sample') === 'translation is identical to the English source',
    'strict structural check accepted untranslated ordinary descriptors',
  ],
  ...negativeExamples.map(([en, faithful, reversed]) => [
    checkPairQuality(fullReport(en), fullReport(faithful)).length === 0
      && checkPairQuality(fullReport(en), fullReport(reversed))
        .some((issue) => issue.code === 'hedge-preservation'),
    `negative qualifier matching failed for: ${en}`,
  ]),
  [
    editorialQualityImproved(
      { errorCount: 0, warningCount: 10 },
      { errorCount: 0, warningCount: 2 },
    ),
    'editor rejected a strict advisory reduction',
  ],
  [
    !editorialQualityImproved(
      { errorCount: 0, warningCount: 2 },
      { errorCount: 0, warningCount: 2 },
    ) && !editorialQualityImproved(
      { errorCount: 0, warningCount: 2 },
      { errorCount: 1, warningCount: 0 },
    ),
    'editor accepted a non-improving or semantically unsafe revision',
  ],
];

const failures = checks.filter(([ok]) => !ok).map(([, message]) => message);
if (failures.length) {
  for (const failure of failures) console.error(`[check-translation-editor] ${failure}`);
  process.exit(1);
}

const fixtureRoot = mkdtempSync(join(tmpdir(), 'translation-quality-audit-'));
try {
  const reportDir = join(fixtureRoot, 'reports', 'audit-fixture');
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(join(reportDir, 'full-report.yaml'), JSON.stringify(source));
  writeFileSync(join(reportDir, 'full-report.zh.yaml'), JSON.stringify(changedMetric));
  writeFileSync(join(reportDir, 'summary-card.yaml'), JSON.stringify({ artifact: 'summary-card' }));
  const auditScript = new URL('./audit-translations.mjs', import.meta.url);
  for (const strictEditor of [false, true]) {
    const child = spawnSync(process.execPath, [
      fileURLToPath(auditScript), '--report', 'audit-fixture', '--format', 'json',
      ...(strictEditor ? ['--strict-editor'] : []),
    ], { cwd: fixtureRoot, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    const audit = JSON.parse(child.stdout);
    assert.equal(audit.strictEditor, strictEditor);
    assert.equal(audit.checkedPairs, 1);
    assert.equal(audit.missingOverlayPairs, 1);
    assert.equal(audit.reports[0].missingOverlayPairs, 1);
    assert.equal(audit.errorCount, strictEditor ? 1 : 0);
    assert.equal(audit.cleanPairs, strictEditor ? 0 : 1);
    assert.equal(audit.hardPassPairs, strictEditor ? 0 : 1);
    assert.equal(audit.reports[0].errorCount, audit.errorCount);
    if (strictEditor) assert.equal(audit.findings[0].code, 'metric-preservation');
  }
  const missingDir = join(fixtureRoot, 'reports', 'missing-overlay-fixture');
  mkdirSync(missingDir);
  writeFileSync(join(missingDir, 'full-report.yaml'), JSON.stringify(source));
  const missing = spawnSync(process.execPath, [
    fileURLToPath(auditScript), '--report', 'missing-overlay-fixture', '--strict-editor', '--format', 'json',
  ], { cwd: fixtureRoot, encoding: 'utf8' });
  assert.equal(missing.status, 0, missing.stderr);
  const unassessed = JSON.parse(missing.stdout);
  assert.equal(unassessed.checkedPairs, 0);
  assert.equal(unassessed.missingOverlayPairs, 1);
  assert.equal(unassessed.hardPassRatePct, null);
  assert.equal(unassessed.cleanRatePct, null);
  assert.equal(unassessed.reports[0].hardPassRatePct, null);
  assert.equal(unassessed.reports[0].cleanRatePct, null);
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log('[check-translation-editor] ✓ source-anchored editor gates verified.');
