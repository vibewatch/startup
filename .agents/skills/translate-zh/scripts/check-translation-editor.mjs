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
