#!/usr/bin/env node
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

console.log('[check-translation-editor] ✓ source-anchored editor gates verified.');
