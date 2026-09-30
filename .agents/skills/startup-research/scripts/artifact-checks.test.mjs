import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';
import { canonicalCacheKey, cleanExtractedText, htmlToText, isAccessErrorResponse, looksLikeBotChallenge, readerUrl } from '../../fetch-url/scripts/fetch.mjs';
import { checkAuthoringInstructions, checkFigureDeep } from './artifact-checks.mjs';
import { KNOWN_DIMENSIONS, WARNING_DIMENSIONS } from './validation-catalog.mjs';
import { checkDistinctChapterSources, checkPrefetchedSourceQuotes, isVerbatimSourceQuote } from './source-quote-checks.mjs';
import { checkRefreshReadback, refreshArtifactsAreInSync } from './refresh-readback.mjs';
import { reportsDir } from './utils.mjs';
import { barSeries, barSeriesTable, figureDetail, figureItemNotes, figureUnitsDiffer, figureValueNotes, flowRelationshipTable, flowTopology, formatRangeValue, funnelStageTable, matrixCellText, rangeAxisTickIndices, rangeCenterValue, stackLayerDetails, waterfallValueTable, withFlowTopology, withRangeTones } from '../../../../website/src/lib/figures.mjs';
import { isTranslatableLeaf, TRANSLATE_PATHS } from '../../translate-zh/scripts/whitelist.mjs';
import { asArray, asRecord, claimRefs } from '../../../../website/src/lib/report-types.ts';
import { t } from '../../../../website/src/lib/i18n.ts';

test('table evidence references wrap instead of hiding later links and scrolling the whole table', () => {
  const table = readFileSync('website/src/components/DataTable.astro', 'utf8');
  const references = table.match(/\.table-frame :global\(\.claim-ref\)\s*\{([^}]*)\}/);
  assert.ok(references);
  assert.match(references[1], /white-space:\s*normal/);
  assert.doesNotMatch(references[1], /white-space:\s*nowrap/);
  const refs = Array.from({ length: 20 }, (_, index) => `CE${String(index + 1).padStart(3, '0')}`);
  assert.deepEqual(claimRefs({ claimRefs: refs }), refs);
});

test('matrix renderer and validator share canonical display aliases and preserve explicit empty labels', () => {
  const cases = [
    [null, ''], ['', ''], ['Not disclosed', 'Not disclosed'], [0, '0'], [-2.5, '-2.5'],
    [{ label: 'Canonical', text: 'Text', name: 'Name', displayValue: 'Display', value: 7, score: 3 }, 'Canonical'],
    [{ label: null, text: 'Text', name: 'Name', displayValue: 'Display', value: 7, score: 3 }, 'Text'],
    [{ name: 'Name', displayValue: 'Display', value: 7, score: 3 }, 'Name'],
    [{ displayValue: 'Display', value: 7, score: 3 }, 'Display'],
    [{ value: 0, score: 3 }, '0'], [{ score: 0 }, '0'],
    [{ label: '', text: 'Must not replace the blank', score: 3, tone: 'neutral' }, ''],
    [{ text: '', value: 3, tone: 'warning' }, ''],
    [{ text: '无公开证据', detail: '不代表事件未发生', note: '仅为公司口径' }, '无公开证据'],
  ];
  for (const [cell, expected] of cases) {
    const before = structuredClone(cell);
    if (cell && typeof cell === 'object') Object.freeze(cell);
    assert.equal(matrixCellText(cell), expected);
    assert.deepEqual(cell, before);
    assert.deepEqual(checkFigureDeep({
      id: 'FR001', title: 'Matrix', type: 'matrix',
      data: { columns: ['Column'], rows: [{ label: 'Row', values: [cell] }] },
    }, { path: 'matrix-test' }).errors, []);
  }
});

test('matrix qualifications retain both distinct notes without treating unknown fields as prose', () => {
  for (const [cell, expected] of [
    [{ detail: 'Estimated', note: 'Company assertion' }, ['Estimated', 'Company assertion']],
    [{ detail: 'Same qualification', note: 'Same qualification' }, ['Same qualification']],
    [{ detail: '', note: 'Disclosure gap' }, ['Disclosure gap']],
    [{ detail: null, note: null, unknown: 'Not a supported prose field' }, []],
  ]) {
    assert.deepEqual(figureItemNotes({ detail: cell.detail, note: cell.note }), expected);
  }
});

test('matrix column notes are translatable without exposing structural fields or unrelated row sidecars', () => {
  for (const key of ['label', 'detail', 'note']) {
    assert.equal(isTranslatableLeaf(['figures', 0, 'data', 'columns', 0, key], TRANSLATE_PATHS.fullReport), true);
  }
  for (const key of ['id', 'key', 'tone', 'value', 'score', 'Impact']) {
    assert.equal(isTranslatableLeaf(['figures', 0, 'data', 'columns', 0, key], TRANSLATE_PATHS.fullReport), false);
  }
  assert.equal(isTranslatableLeaf(['figures', 0, 'data', 'rows', 0, 'details', 0], TRANSLATE_PATHS.fullReport), false);
  assert.equal(isTranslatableLeaf(['figures', 0, 'data', 'columns', 0, 'note', 'id'], TRANSLATE_PATHS.fullReport), false);
  assert.deepEqual(figureItemNotes({ detail: '12-month horizon', note: 'Analyst assessment' }), ['12-month horizon', 'Analyst assessment']);
  assert.deepEqual(figureItemNotes({ detail: 'Same scope', note: 'Same scope' }), ['Same scope']);
});

test('matrix grids and cards expose qualifications and preserve them in cell tooltips', () => {
  const source = readFileSync('website/src/components/FigureRenderer.astro', 'utf8');
  const matrix = source.slice(source.indexOf('const renderHeatmap ='), source.indexOf('const renderCohort ='));
  assert.match(matrix, /matrixCellText\(cell\)/);
  assert.match(matrix, /figureItemNotes\(\{ detail: column\?\.detail, note: column\?\.note \}\)/);
  assert.match(matrix, /figureItemNotes\(\{ note: row\?\.note \}\)/);
  assert.match(matrix, /figureItemNotes\(\{ detail: cell\?\.detail, note: cell\?\.note \}\)/);
  for (const className of ['matrix-column-detail', 'matrix-row-note', 'matrix-cell-detail', 'matrix-card-detail']) {
    assert.ok(matrix.includes(`'${className} matrix-qualification'`), className);
  }
  assert.equal((matrix.match(/\[d\.text, \.\.\.d\.tooltipNotes\]/g) ?? []).length, 2);
  assert.match(matrix, /!cell\.notes\.length && !cell\.columnNotes\.length/);
  assert.doesNotMatch(matrix, /'No data'|const cellDetail =/);
});

test('range axis keeps domain endpoints and only interior labels with measured clearance', () => {
  for (const [bounds, expected] of [
    [[], []],
    [[{ left: 0, right: 10 }], [0]],
    [[{ left: 0, right: 10 }, { left: 90, right: 100 }], [0, 1]],
    [[{ left: 0, right: 12 }, { left: 60, right: 80 }, { left: 150, right: 170 }, { left: 158, right: 190 }], [0, 1, 3]],
    [[{ left: 0, right: 10 }, { left: 16, right: 28 }, { left: 40, right: 60 }, { left: 80, right: 100 }], [0, 2, 3]],
    [[{ left: 0, right: 10 }, { left: 18, right: 28 }, { left: 36, right: 46 }], [0, 1, 2]],
    [[{ left: 0, right: 10 }, { left: 17.99, right: 28 }, { left: 100, right: 110 }], [0, 2]],
    [[{ left: -150, right: -130 }, { left: -120, right: -90 }, { left: 20, right: 50 }], [0, 1, 2]],
  ]) {
    const before = structuredClone(bounds);
    bounds.forEach(Object.freeze);
    assert.deepEqual(rangeAxisTickIndices(Object.freeze(bounds)), expected);
    assert.deepEqual(bounds, before);
  }
});

test('range axes filter derived out-of-domain ticks and remeasure on font, size and print changes', () => {
  const source = readFileSync('website/src/components/FigureRenderer.astro', 'utf8');
  const range = source.slice(source.indexOf('const renderRange ='), source.indexOf('const renderQuadrant ='));
  assert.match(range, /ticks\(4\)\.filter\(\(value\) => value >= min && value <= max\)/);
  assert.match(range, /layoutRangeAxis\(axis\.node\(\)\)/);
  assert.match(source, /rangeAxisTickIndices\(nodes\.map\(\(node\) => node\.getBoundingClientRect\(\)\)\)/);
  assert.match(source, /node\.hidden = !visible\.has\(index\)/);
  assert.match(source, /document\.fonts\.ready\.then\(\(\) => \{[\s\S]*?layoutRangeAxes\(\);/);
  assert.match(source, /addEventListener\('afterprint', layoutRangeAxes\)/);
  const print = source.slice(source.indexOf("window.addEventListener('beforeprint'"), source.indexOf("window.addEventListener('afterprint'"));
  assert.match(print, /layoutRangeAxes\(\)/);
  const resize = source.slice(source.indexOf('const chartResizeObserver ='), source.indexOf('const renderChartScript ='));
  assert.ok(resize.indexOf('layoutRangeAxis(axis)') >= 0);
  assert.ok(resize.indexOf('layoutRangeAxis(axis)') < resize.indexOf('Math.abs(nextWidth - prevWidth)'));
});

test('range centers preserve explicit aliases and finite numeric base without treating evidence prose as zero', () => {
  const cases = [
    [{ low: 80, base: 147, high: 250 }, 147],
    [{ mid: 0, value: 4, base: 6 }, 0],
    [{ mid: 3, value: 4, base: 6 }, 3],
    [{ mid: null, value: 0, base: 6 }, 0],
    [{ mid: null, value: '0.0425', base: 6 }, '0.0425'],
    [{ mid: null, value: null, base: 0 }, 0],
    [{ base: -0.0425 }, -0.0425],
    [{ low: 1, high: 3 }, undefined],
    ...['public + estimated', 'estimated', 'inferred', '', '147', null, undefined, false, NaN, Infinity, -Infinity]
      .map(base => [{ low: 975, base, high: 1000 }, undefined]),
  ];
  for (const [item, expected] of cases) {
    const before = structuredClone(item);
    assert.equal(rangeCenterValue(Object.freeze(item)), expected);
    assert.deepEqual(item, before);
  }
});

test('range value labels retain authored decimal precision across magnitudes', () => {
  for (const value of [
    0, 0.04, 0.0425, 0.045, 26.055, 26.058, 26.06, 123.456, 1234.56789,
    1234567.890123, 21.040000000000003, 119.999899, -0.0425, -1234.56789, 1e-21, 1e21, Number.MIN_VALUE, Number.MAX_VALUE,
  ]) {
    assert.equal(Number(formatRangeValue(value).replaceAll(',', '')), value);
  }
  assert.equal(formatRangeValue(0.0425), '0.0425');
  assert.equal(formatRangeValue(26.058), '26.058');
  assert.equal(formatRangeValue(1234.56789), '1,234.56789');
  assert.notEqual(formatRangeValue(0.04), formatRangeValue(0.045));
});

test('range renderer uses identical authored values in visible labels and pointer tooltips', () => {
  const source = readFileSync('website/src/components/FigureRenderer.astro', 'utf8');
  const range = source.slice(source.indexOf('const renderRange ='), source.indexOf('const renderQuadrant ='));
  assert.match(range, /numberValue\(rangeCenterValue\(item\) \?\?/);
  assert.match(range, /low: formatRangeValue\(low\)/);
  assert.match(range, /high: formatRangeValue\(high\)/);
  assert.match(range, /rangeCenterValue\(item\) == null \? formatNumber\(mid\) : formatRangeValue\(mid\)/);
  for (const field of ['low', 'mid', 'high']) {
    assert.match(range, new RegExp(`text\\([^\\n]*labels\\.${field}`));
    assert.match(range, new RegExp(`\\$\\{d\\.labels\\.${field}\\}`));
  }
});

test('range descriptors follow the report locale on screen and in pointer tooltips', () => {
  const keys = ['reportRangeLow', 'reportRangeMid', 'reportRangeHigh', 'reportRangeMidInline'];
  assert.deepEqual(keys.map(key => t(key, 'en')), ['Low:', 'Mid:', 'High:', 'mid']);
  assert.deepEqual(keys.map(key => t(key, 'zh')), ['低值：', '中间值：', '高值：', '中间值']);
  const source = readFileSync('website/src/components/FigureRenderer.astro', 'utf8');
  for (const key of keys) assert.ok(source.includes(`t('${key}', locale)`), key);
  assert.match(source, /authoredType === 'range' \? \{ rangeLabels \} : \{\}/);
  const range = source.slice(source.indexOf('const renderRange ='), source.indexOf('const renderQuadrant ='));
  assert.match(range, /text\(`\$\{payload\.rangeLabels\.midInline\} \$\{labels\.mid\}`\)/);
  for (const field of ['low', 'mid', 'high']) {
    assert.match(range, new RegExp(`\\$\\{payload\\.rangeLabels\\.${field}\\} \\$\\{d\\.labels\\.${field}\\}`));
  }
  assert.doesNotMatch(range, /`(?:mid |Low:|Mid:|High:)/);
});

test('generated chart UI uses localized text without translating structural roles', () => {
  const labels = {
    reportFigureItem: ['Item', '条目'],
    reportFigureLoading: ['Loading figure…', '图表加载中…'],
    reportFigureRenderError: ['Figure could not be rendered.', '图表无法显示。'],
    reportFigureGenericTitle: ['Generic figure', '通用图表'],
    reportFigureGenericDescription: ['Fallback renderer for generic figures.', '通用图表的备用显示区域。'],
    reportDagDependency: ['Dependency:', '依赖关系：'],
    reportDagInput: ['Input dependency', '输入依赖'],
    reportDagImpact: ['Downstream impact', '下游影响'],
    reportDagCore: ['Core dependency', '核心依赖'],
    reportWaterfallMetadata: ['Authored metadata', '原文标注'],
  };
  const source = readFileSync('website/src/components/FigureRenderer.astro', 'utf8');
  for (const [key, [en, zh]] of Object.entries(labels)) {
    assert.equal(t(key, 'en'), en, key);
    assert.equal(t(key, 'zh'), zh, key);
    assert.ok(source.includes(`t('${key}', locale)`), key);
  }
  assert.match(source, /authoredType === 'dag' \? \{ dagLabels \} : \{\}/);
  assert.match(source, /payload\.dagLabels\[node\._role\]/);
  assert.match(source, /payload\.dagLabels\.dependency/);
  assert.match(source, /content: attr\(data-loading-label\)/);
  assert.match(source, /data-loading-label=\{t\('reportFigureLoading', locale\)\}/);
  assert.match(source, /data-error-label=\{t\('reportFigureRenderError', locale\)\}/);
  assert.match(source, /text\(element\.dataset\.errorLabel\)/);
  assert.match(source, /console\.error\(`\[FigureRenderer\] Failed to render/);
  assert.doesNotMatch(source, /\.text\('Waterfall bridge'\)|'Input dependency'|'Downstream impact'|'Core dependency'|content: 'Loading figure/);
});

test('localized item fallbacks preserve authored labels, identifiers, empty strings and input data', () => {
  const source = readFileSync('website/src/components/FigureRenderer.astro', 'utf8');
  const expression = source.match(/const normalizedItems = (.+);/)?.[1];
  assert.ok(expression);
  const normalize = new Function('firstNonEmpty', 'arr', 'figureDetail', `return (${expression});`)(
    (...values) => values.find(value => Array.isArray(value) && value.length) ?? [],
    value => Array.isArray(value) ? value : [], figureDetail);
  const items = [{ label: '', name: 'Ignored', value: 0 }, { value: 2 }, { id: 'SKU-4', value: 4 }, { name: 'OpenAI', value: 7 }];
  const before = structuredClone(items);
  items.forEach(Object.freeze);
  Object.freeze(items);
  for (const [locale, expected] of [['en', 'Item 2'], ['zh', '条目 2']]) {
    assert.deepEqual(normalize({ items }, t('reportFigureItem', locale)).map(item => item.label), ['', expected, 'SKU-4', 'OpenAI']);
  }
  assert.deepEqual(items, before);
  assert.equal((source.match(/normalizedItems\(payload\.data, payload\.itemLabel\)/g) ?? []).length, 3);
  assert.match(source, /normalizedItems\(\{ items: payload\.data\.items \?\? payload\.data\.nodes \}, payload\.itemLabel\)/);
  assert.match(source, /entry\.label \?\? entry\.name \?\? entry\.id \?\? `\$\{itemLabel\} \$\{index \+ 1\}`/);
});

test('waterfall values retain order, precision, declared roles and qualifications without inferred totals', () => {
  const items = [
    { label: 'Tranche', value: 250, note: 'Estimated commitment, not drawn cash.', unit: 'EUR M' },
    { label: 'Tranche', value: 215, unit: 'EUR M' },
    { label: 'Last facility', value: 700, unit: 'EUR M' },
    { label: 'Explicit total', value: 0, kind: 'total', unit: 'USD M', tone: 'risk' },
    { label: 'Declared change', value: -26.058, kind: 'debt', role: 'decrease', detail: 'Reported.', context: 'Different period.', unit: 'USD M' },
    { label: 'Blank display', value: 5, displayValue: '', role: 'delta' },
  ];
  const before = structuredClone(items);
  items.forEach(Object.freeze);
  Object.freeze(items);
  const labels = { valueLabel: 'Value', contextLabel: 'Context', metadataLabel: 'Authored metadata' };
  const table = waterfallValueTable({ items }, labels);
  assert.deepEqual(table.columns, ['Value', 'Authored metadata', 'Context']);
  assert.deepEqual(table.rows.map(row => row.label), items.map(item => item.label));
  assert.deepEqual(table.rows.map(row => row.values[0].value), [250, 215, 700, 0, -26.058, 5]);
  assert.deepEqual(table.rows.map(row => row.values[0].label), ['250', '215', '700', '0', '-26.058', '']);
  assert.deepEqual(table.rows.map(row => row.values[1]), [null, null, null, 'kind: total', 'kind: debt\nrole: decrease', 'role: delta']);
  assert.equal(table.rows[0].values[0].detail, 'EUR M\nEstimated commitment, not drawn cash.');
  assert.equal(table.rows[3].values[0].tone, 'risk');
  assert.equal(table.rows[4].values[0].detail, 'USD M\nReported.\nDifferent period.\nkind: debt\nrole: decrease');
  assert.deepEqual(items, before);
  const undeclared = waterfallValueTable({ items: items.slice(0, 3) }, labels);
  assert.deepEqual(undeclared.columns, ['Value', 'Context']);
  assert.deepEqual(undeclared.rows.map(row => row.values[0].value), [250, 215, 700]);
  assert.deepEqual(waterfallValueTable({ items: [{ label: 'Only', value: 0 }] }, labels).columns, ['Value']);
  const zh = waterfallValueTable({ items }, { valueLabel: '数值', contextLabel: '说明', metadataLabel: '原文标注' });
  assert.deepEqual(zh.rows, table.rows);
  assert.deepEqual(zh.columns, ['数值', '原文标注', '说明']);
});

test('waterfall metadata retains literal conflicting declarations, zero bases and authored cumulative values', () => {
  const items = [
    { label: 'Conflicting', value: 3, type: 'delta', kind: 'total', role: 'unknown-role', isTotal: false,
      category: 'debt', direction: 'up', status: 'estimated', base: 0, cumulative: -26.058, tone: 'risk' },
    { label: 'Explicit total', value: 2, isTotal: true, cumulative: 99.0425 },
    { label: 'No metadata', value: 1 },
    { label: 'Empty status', value: 0, status: '', kind: null, unrelated: 'Not a declaration' },
  ];
  const before = structuredClone(items);
  items.forEach(Object.freeze);
  Object.freeze(items);
  const table = waterfallValueTable({ items }, { valueLabel: 'Value', contextLabel: 'Context', metadataLabel: 'Authored metadata' });
  const declarations = [
    'type: delta\nkind: total\nrole: unknown-role\nisTotal: false\ncategory: debt\ndirection: up\nstatus: estimated\nbase: 0\ncumulative: -26.058',
    'isTotal: true\ncumulative: 99.0425',
    null,
    'status: ',
  ];
  assert.deepEqual(table.columns, ['Value', 'Authored metadata']);
  assert.deepEqual(table.rows.map(row => row.values[1]), declarations);
  assert.deepEqual(table.rows.map(row => row.values[0].value), [3, 2, 1, 0]);
  assert.deepEqual(table.rows.map(row => row.values[0].label), ['3', '2', '1', '0']);
  for (const [index, declaration] of declarations.entries()) {
    assert.equal(table.rows[index].values[0].detail, declaration ?? '');
  }
  assert.equal(table.rows[0].values[0].tone, 'risk');
  assert.deepEqual(items, before);
});

test('waterfall rendering uses source-value tables and explicitly disclaims invented cumulative arithmetic', () => {
  const source = readFileSync('website/src/components/FigureRenderer.astro', 'utf8');
  assert.match(source, /const waterfall = authoredType === 'waterfall'/);
  assert.match(source, /const type = funnel \|\| waterfall \|\|/);
  assert.match(source, /waterfall \? waterfallValueTable\(data,/);
  assert.match(source, /class="figure-note waterfall-comparison-notice"[^>]*>\{t\('reportWaterfallNotice', locale\)\}/);
  assert.doesNotMatch(source, /renderWaterfall|totalLike|waterfall-step|waterfallLabels/);
  assert.match(t('reportWaterfallNotice', 'en'), /No additive steps, cumulative totals, or shared unit or time basis are inferred/);
  assert.match(t('reportWaterfallNotice', 'zh'), /不推定各项可以相加，不计算累计值/);
  const report = readFileSync('website/src/components/DiligenceReport.astro', 'utf8');
  const print = report.slice(report.indexOf('@media print'));
  assert.match(print, /\.native-figure:has\(\.waterfall-comparison-notice\) \.matrix-card\)\s*\{[^}]*break-inside: avoid;[^}]*page-break-inside: avoid;/);
});

test('refresh acceptance checks both reports and existing overlays without rewriting history', () => {
  const runId = '20990101000000-refresh-check';
  const previousRunId = '20980101000000-refresh-check';
  const reportFolder = join('.research-cache', runId);
  const refreshContext = { refreshOfRunId: previousRunId, refreshReason: 'Correct the dated financial disclosures.' };
  const current = { status: 'current', refreshOfRunId: previousRunId, supersededByRunId: null, refreshReason: refreshContext.refreshReason };
  const previous = { status: 'superseded', refreshOfRunId: '20970101000000-refresh-check', supersededByRunId: runId, refreshReason: 'Preserve the earlier refresh reason.' };
  const documents = new Map();
  for (const [folder, revision] of [[reportFolder, current], [join(reportsDir, previousRunId), previous]]) {
    for (const file of ['report-meta.yaml', 'summary-card.yaml', 'full-report.yaml', 'summary-card.zh.yaml', 'full-report.zh.yaml']) {
      documents.set(join(folder, file), { revision });
    }
  }
  const check = () => checkRefreshReadback({ reportFolder, runId, refreshContext },
    (path) => structuredClone(documents.get(path)), (path) => documents.has(path));
  const before = structuredClone(documents);
  const oldFolder = join(reportsDir, previousRunId);
  const inSync = () => refreshArtifactsAreInSync(oldFolder, previous,
    (path) => documents.get(path), (path) => documents.has(path));
  assert.equal(inSync(), true);
  for (const file of ['summary-card.yaml', 'full-report.yaml', 'summary-card.zh.yaml', 'full-report.zh.yaml']) {
    const path = join(oldFolder, file);
    documents.set(path, { revision: { ...previous, status: 'current', supersededByRunId: null } });
    assert.equal(inSync(), false, `stale ${file} must trigger revision-only recovery`);
    documents.set(path, before.get(path));
  }
  assert.deepEqual(check(), []);
  assert.deepEqual(documents, before);
  assert.deepEqual(checkRefreshReadback({ reportFolder, runId, refreshContext: null }, () => {
    throw new Error('Fresh runs must not inspect refresh artifacts');
  }), []);
  for (const [path, original] of before) {
    for (const revision of [
      undefined, null, {}, 'current', { ...original.revision, status: 'unknown' },
      { ...original.revision, supersededByRunId: '20960101000000-wrong' },
      { ...original.revision, refreshReason: 'Unapproved reason' },
    ]) {
      documents.set(path, { revision });
      assert(check().length > 0,
        `accepted broken revision in ${path}: ${JSON.stringify(revision)}`);
    }
    documents.set(path, original);
  }
  const summaryPath = join(reportFolder, 'summary-card.yaml');
  documents.set(summaryPath, { revision: { ...current, refreshOfRunId: '20960101000000-wrong' } });
  assert(check().some((issue) => issue.path === `${summaryPath}:revision`));
  documents.set(summaryPath, before.get(summaryPath));
  for (const path of [...documents.keys()].filter(path => path.endsWith('.zh.yaml'))) documents.delete(path);
  assert.deepEqual(check(), [], 'English-only runs do not require nonexistent overlays');
  assert.equal(inSync(), true);
  const oldSummary = join(oldFolder, 'summary-card.yaml');
  documents.delete(oldSummary);
  assert.equal(inSync(), false, 'missing English artifacts cannot be considered synchronized');
  documents.set(oldSummary, before.get(oldSummary));
  documents.delete(summaryPath);
  assert(check().some((issue) => issue.path === `${summaryPath}:revision`));
});

test('timeline rows use shared pointer tooltips with full date and detail', () => {
  const source = readFileSync('website/src/components/FigureRenderer.astro', 'utf8');
  const timeline = source.slice(source.indexOf('const renderTimeline ='), source.indexOf('const renderStack ='));
  assert.match(timeline, /withTooltip\(rows, \(d\) => tooltipHtml\(d\.label, \[d\.date, d\.detail\]\)\)/);
  assert.match(timeline, /renderLineBlock\(d3\.select\(this\), d\.detailLines/);
});

test('timelines print complete ordered events at body-text size without hiding measurable SVGs', () => {
  const source = readFileSync('website/src/components/FigureRenderer.astro', 'utf8');
  const timeline = source.slice(source.indexOf('const renderTimeline ='), source.indexOf('const renderStack ='));
  assert.match(timeline, /append\('ol'\)\.attr\('class', 'timeline-print-events'\)/);
  assert.match(timeline, /printEvents\.selectAll\('li'\)\.data\(rowsData\)\.join\('li'\)/);
  assert.match(timeline, /style\('border-left-color', \(d\) => colorForTone\(d\.tone\)\)/);
  const date = timeline.match(/printRows\.filter\(\(d\) => (.*?)\)\.append\('p'\)\.text\(\(d\) => (.*?)\);/);
  assert.ok(date);
  const dateRow = new Function('d', 'safeText', `return { visible: (${date[1]}), text: (${date[2]}) };`);
  for (const [item, expected] of [
    [{ label: '2026: Founded' }, { visible: false, text: undefined }],
    [{ date: '2026-09-30' }, { visible: true, text: '2026-09-30' }],
    [{ period: 'Q1 2026' }, { visible: true, text: 'Q1 2026' }],
    [{ year: 2026 }, { visible: true, text: 2026 }],
    [{ date: 0 }, { visible: true, text: 0 }],
    [{ date: '', year: 2026 }, { visible: false, text: '' }],
  ]) assert.deepEqual(dateRow(item, value => String(value ?? '')), expected);
  assert.match(timeline, /printRows\.append\('strong'\)\.text\(\(d\) => d\.label\)/);
  assert.match(timeline, /printRows\.filter\(\(d\) => safeText\(d\.detail\)\.trim\(\) !== ''\)\.append\('p'\)\.text\(\(d\) => d\.detail\)/);
  assert.match(source, /:global\(\.timeline-print-events\) \{ display: none; \}/);
  const report = readFileSync('website/src/components/DiligenceReport.astro', 'utf8');
  const print = report.slice(report.indexOf('@media print {')).replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (selector) => {
    const match = [...print.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .find(([, selectors]) => selectors.split(',').some(value => value.trim() === selector));
    assert.ok(match, `missing print rule for ${selector}`);
    return match[2];
  };
  assert.match(rule(':global(.native-figure:has(.chart-timeline))'), /break-inside: auto; page-break-inside: auto;/);
  const svg = rule(':global(.chart-timeline > svg)');
  assert.match(svg, /position: absolute; visibility: hidden;/);
  assert.doesNotMatch(svg, /display:\s*none/);
  assert.match(rule(':global(.timeline-print-events)'), /display: block !important;[^}]*font-size: 10pt;/);
  assert.match(rule(':global(.timeline-print-events > li)'), /break-inside: avoid; page-break-inside: avoid;/);
  assert.match(rule(':global(.timeline-print-events p)'), /font-size: 10pt;/);
});

test('pyramid layers expose authored values and all qualifications in visible text and pointer tooltips', () => {
  const source = readFileSync('website/src/components/FigureRenderer.astro', 'utf8');
  const pyramid = source.slice(source.indexOf('const renderPyramid ='), source.indexOf('const renderJourneyMap ='));
  assert.match(pyramid, /fullValueLabel\(item\), \.\.\.figureValueNotes\(item\)/);
  assert.match(pyramid, /withTooltip\(groups, \(entry\) => tooltipHtml\(entry\.item\.label, entry\.details\)\)/);
  assert.match(pyramid, /addTitle\(d3\.select\(this\), \[entry\.item\.label, \.\.\.entry\.details\]/);
  assert.match(pyramid, /renderLineBlock\(d3\.select\(this\), entry\.detailLines/);
  assert.match(pyramid, /createSvgTextWrapper\(svg\)/);
  assert.match(pyramid, /wrap\(item\.label, \{[^}]*maxWidth: w - padX \* 2/);
  assert.match(pyramid, /details\.flatMap\(\(detail\) => textWrapper\.wrap\(detail, \{[^}]*maxWidth: w - padX \* 2/);
  assert.match(pyramid, /const w = maxW \* \(1 - index \* widthStep\)/);
  assert.match(source, /class="figure-note pyramid-layout-notice"[^>]*>\{t\('reportPyramidLayoutNotice', locale\)\}/);
});

test('deep pyramids keep every layer at a positive readable width without changing ordinary layouts', () => {
  const source = readFileSync('website/src/components/FigureRenderer.astro', 'utf8');
  const pyramid = source.slice(source.indexOf('const renderPyramid ='), source.indexOf('const renderJourneyMap ='));
  const expression = pyramid.match(/const widthStep = (.+);/)?.[1];
  assert.ok(expression, 'the existing 12-layer report must not produce zero or negative widths');
  const step = new Function('items', `return (${expression});`);
  for (const count of [0, 1, 3, 4, 5, 6, 7, 12, 100]) {
    const items = Object.freeze(Array.from({ length: count }, (_, index) => Object.freeze({ label: `Layer ${index}` })));
    const before = structuredClone(items);
    const widthStep = step(items);
    assert(Number.isFinite(widthStep));
    for (const [index] of items.entries()) {
      const fraction = 1 - index * widthStep;
      assert(fraction >= 0.5 - Number.EPSILON && fraction <= 1);
      if (count <= 6) assert.equal(fraction, 1 - index * 0.1);
      if (index) assert(fraction <= 1 - (index - 1) * widthStep);
    }
    assert.deepEqual(items, before);
  }
});

test('pyramid content preserves explicit value aliases, zeros, precision and distinct notes without inventing quantities', () => {
  const source = readFileSync('website/src/components/FigureRenderer.astro', 'utf8');
  const pyramid = source.slice(source.indexOf('const renderPyramid ='), source.indexOf('const renderJourneyMap ='));
  const expression = pyramid.match(/const details = ([\s\S]+?);\n/)?.[1];
  assert.ok(expression, 'pyramid content must feed both measured text and tooltips');
  const fullValueLabel = new Function(`return (${source.match(/const fullValueLabel = (.+);/)?.[1]});`)();
  const details = new Function('item', 'fullValueLabel', 'figureValueNotes', 'safeText', `return (${expression});`);
  const safeText = value => String(value ?? '');
  const cases = [
    [{ label: 'TAM', value: 15, unit: '$B', note: 'Government IT allocation.' }, ['15', 'Government IT allocation.', '$B']],
    [{ label: 'SOM', value: 0.1, unit: '$B', note: 'ARR undisclosed.' }, ['0.1', 'ARR undisclosed.', '$B']],
    [{ label: 'Zero', value: 0, unit: '%' }, ['0', '%']],
    [{ label: '精确值', value: '0.042500000000000003', context: '未经审计' }, ['0.042500000000000003', '未经审计']],
    [{ label: 'Large count', value: '9007199254740993' }, ['9007199254740993']],
    [{ label: 'Loss', value: -139.6, unit: 'R$mn' }, ['-139.6', 'R$mn']],
    [{ label: 'Value', displayValue: 'Authored display', value: 7, score: 3 }, ['Authored display']],
    [{ label: 'Value', displayValue: 0, value: 7 }, ['0']],
    [{ label: 'Value', displayValue: '', value: 7, note: 'Still qualified.' }, ['Still qualified.']],
    [{ label: 'Score', displayValue: null, value: null, score: 0 }, ['0']],
    [{ label: 'Concept only' }, []],
    [{ label: 'Same text', value: 'Same text', detail: 'Same text' }, []],
    [{ label: 'Qualified', value: 3, detail: 'Basis.', description: 'Definition.', note: 'Estimate.',
      notes: 'Period.', context: 'Scope.', valueNote: 'Not a forecast.', unit: '$B' },
    ['3', 'Basis.', 'Definition.', 'Estimate.', 'Period.', 'Scope.', 'Not a forecast.', '$B']],
    [{ label: 'Dedupe', value: 'Unaudited.', note: 'Unaudited.', context: 'Unaudited.' }, ['Unaudited.']],
    [{ label: 'Summary', summary: 'Limited sample.', note: 'Other scope.' }, ['Limited sample.', 'Other scope.']],
    [{ label: 'Empty detail', detail: '', description: 'Known scope.', unit: '$B' }, ['Known scope.', '$B']],
    [{ label: 'Escaped', note: '<b>Not markup</b> & a condition.' }, ['<b>Not markup</b> & a condition.']],
  ];
  for (const [item, expected] of cases) {
    const before = structuredClone(item);
    const normalized = Object.freeze({ ...item, detail: figureDetail(item) ?? item.summary });
    assert.deepEqual(details(normalized, fullValueLabel, figureValueNotes, safeText), expected);
    assert.deepEqual(item, before);
  }
});

test('pyramid node notes are translatable while values, units and structured sidecars remain protected', () => {
  for (const key of ['label', 'detail', 'details', 'description', 'note', 'notes']) {
    assert.equal(isTranslatableLeaf(['figures', 0, 'data', 'nodes', 0, key], TRANSLATE_PATHS.fullReport), true);
  }
  for (const key of ['id', 'value', 'displayValue', 'score', 'unit', 'tone', 'claimRefs']) {
    assert.equal(isTranslatableLeaf(['figures', 0, 'data', 'nodes', 0, key], TRANSLATE_PATHS.fullReport), false);
  }
  assert.equal(isTranslatableLeaf(['figures', 0, 'data', 'nodes', 0, 'notes', 'id'], TRANSLATE_PATHS.fullReport), false);
  assert.equal(isTranslatableLeaf(['figures', 0, 'data', 'nodes', 0, 'notes', 0], TRANSLATE_PATHS.fullReport), false);
});

test('pyramid layers, timeline events and waterfall values retain their own ordered evidence references beside figure references', () => {
  const source = readFileSync('website/src/components/FigureRenderer.astro', 'utf8');
  assert.match(source, /pyramid-layer-evidence/);
  assert.match(source, /pyramid-layer-reference/);
  assert.match(source, /refs: claimRefs\(item\)/);
  assert.match(source, /timeline-event-evidence/);
  assert.match(source, /timeline-event-reference/);
  assert.match(source, /waterfall-value-evidence/);
  assert.match(source, /waterfall-value-reference/);
  assert.match(source, /<ClaimRefs refs=\{item\.refs\} claims=\{claims\} sources=\{sources\}/);
  assert.match(source, /<ClaimRefs refs=\{claimRefs\(figure\)\}/);
  const logic = source.slice(source.indexOf('const evidenceItems ='), source.indexOf('const stackLabels:'));
  const evidence = new Function('authoredType', 'data', 'asArray', 'asRecord', 'claimRefs', 'itemLabel',
    `${logic}; return itemEvidence;`);
  const tenRefs = Array.from({ length: 10 }, (_, index) => `C${index + 1}`);
  const cases = [
    ['pyramid', { nodes: [{ label: 'TAM', claimRefs: tenRefs }] }, [{ label: 'TAM', refs: tenRefs }]],
    ['pyramid', { items: [{ label: 'Items', claimRefs: ['C3', 'C1', 'C3'] }], nodes: [{ label: 'Nodes', claimRefs: ['C2'] }] },
      [{ label: 'Items', refs: ['C3', 'C1', 'C3'] }]],
    ['pyramid', { items: [], nodes: [{ name: 'Named', claimRefs: ['C2'] }] }, [{ label: 'Named', refs: ['C2'] }]],
    ['pyramid', { nodes: [{ label: 'Repeated', claimRefs: ['C1'] }, { label: 'Repeated', claimRefs: ['C2'] }] },
      [{ label: 'Repeated', refs: ['C1'] }, { label: 'Repeated', refs: ['C2'] }]],
    ['pyramid', { nodes: [{ label: 'No refs' }, { id: 'N002', claimRefs: ['C2'] }, { claimRefs: ['C3'] }] },
      [{ label: 'N002', refs: ['C2'] }, { label: 'Item 3', refs: ['C3'] }]],
    ['pyramid', { nodes: [{ label: '', name: 'Ignored', claimRefs: ['C1'] }] }, [{ label: '', refs: ['C1'] }]],
    ['pyramid', { items: {}, nodes: [{ label: 'TAM', claimRefs: ['C1'] }] }, [{ label: 'TAM', refs: ['C1'] }]],
    ['pyramid', {}, []],
    ['timeline', { items: [{ label: 'Event', claimRefs: tenRefs }] }, [{ label: 'Event', refs: tenRefs }]],
    ['timeline', { items: [{ label: 'First', claimRefs: ['C3', 'C1', 'C3'] }], nodes: [{ label: 'Ignored', claimRefs: ['C2'] }] },
      [{ label: 'First', refs: ['C3', 'C1', 'C3'] }]],
    ['timeline', { items: [{ label: 'No refs' }], nodes: [{ label: 'Ignored', claimRefs: ['C2'] }] }, []],
    ['timeline', { items: [], nodes: [{ name: 'Node', claimRefs: ['C1'] }] }, [{ label: 'Node', refs: ['C1'] }]],
    ['timeline', { layers: [{ id: 'Layer', claimRefs: ['C2'] }], points: [{ label: 'Ignored', claimRefs: ['C3'] }] },
      [{ label: 'Layer', refs: ['C2'] }]],
    ['timeline', { series: [{ points: [{ label: 'Series', claimRefs: ['C1'] }] }], points: [{ label: 'Ignored', claimRefs: ['C2'] }] },
      [{ label: 'Series', refs: ['C1'] }]],
    ['timeline', { series: [{ points: [] }, { points: [{ label: 'Ignored', claimRefs: ['C1'] }] }],
      points: [{ label: 'Point', claimRefs: ['C2'] }] }, [{ label: 'Point', refs: ['C2'] }]],
    ['timeline', { points: [{ label: '', name: 'Ignored', claimRefs: ['C1'] }, { claimRefs: ['C2'] }] },
      [{ label: '', refs: ['C1'] }, { label: 'Item 2', refs: ['C2'] }]],
    ['timeline', {}, []],
    ['waterfall', { items: [{ label: 'Tranche', claimRefs: tenRefs }] }, [{ label: 'Tranche', refs: tenRefs }]],
    ['waterfall', { items: [{ label: 'Duplicate', claimRefs: ['C3', 'C1', 'C3'] }, { label: 'Duplicate', claimRefs: ['C2'] }],
      nodes: [{ label: 'Ignored', claimRefs: ['C4'] }] },
      [{ label: 'Duplicate', refs: ['C3', 'C1', 'C3'] }, { label: 'Duplicate', refs: ['C2'] }]],
    ['waterfall', { items: [], nodes: [{ label: 'Ignored', claimRefs: ['C1'] }] }, []],
    ['waterfall', { items: [{ label: '', name: 'Ignored', claimRefs: ['C1'] }, { claimRefs: ['C2'] },
      { id: 'Not the table label', claimRefs: ['C3'] }] },
      [{ label: '', refs: ['C1'] }, { label: '#2', refs: ['C2'] }, { label: '#3', refs: ['C3'] }]],
    ['kpi', { items: [{ label: 'Other chart', claimRefs: ['C1'] }] }, []],
  ];
  for (const [type, data, expected] of cases) {
    const before = structuredClone(data);
    assert.deepEqual(evidence(type, data, asArray, asRecord, claimRefs, t('reportFigureItem', 'en')), expected);
    assert.deepEqual(data, before);
  }
  assert.deepEqual(evidence('pyramid', { items: [{ claimRefs: ['C2', 'C1'] }, { label: 'Item 2', claimRefs: ['C3'] }] },
    asArray, asRecord, claimRefs, t('reportFigureItem', 'zh')),
  [{ label: '条目 1', refs: ['C2', 'C1'] }, { label: 'Item 2', refs: ['C3'] }]);
  const waterfallItems = [{ value: 0, id: 'ID1', claimRefs: ['C1'] },
    { value: 2, name: 'Named', claimRefs: ['C2'] }, { value: 3, label: '', claimRefs: ['C3'] }];
  const rows = waterfallValueTable({ items: waterfallItems }, { valueLabel: 'Value', contextLabel: 'Context', metadataLabel: 'Authored metadata' }).rows;
  for (const locale of ['en', 'zh']) {
    assert.deepEqual(evidence('waterfall', { items: waterfallItems }, asArray, asRecord, claimRefs, t('reportFigureItem', locale)).map(item => item.label),
      rows.map(row => row.label));
  }
});

test('pyramids print ordered complete layers at body-text size rather than shrinking dense SVGs', () => {
  const source = readFileSync('website/src/components/FigureRenderer.astro', 'utf8');
  const pyramid = source.slice(source.indexOf('const renderPyramid ='), source.indexOf('const renderJourneyMap ='));
  assert.match(pyramid, /append\('ol'\)\.attr\('class', 'pyramid-print-layers'\)/);
  assert.match(pyramid, /printLayers\.selectAll\('li'\)\.data\(layout\)\.join\('li'\)/);
  assert.match(pyramid, /style\('border-left-color', \(entry\) => colorForTone\(entry\.item\.tone\)\)/);
  assert.match(pyramid, /printRows\.append\('strong'\)\.text\(\(entry\) => entry\.item\.label\)/);
  assert.match(pyramid, /printRows\.selectAll\('p'\)\.data\(\(entry\) => entry\.details\)\.join\('p'\)\.text\(\(detail\) => detail\)/);
  assert.match(source, /:global\(\.pyramid-print-layers\) \{ display: none; \}/);
  const report = readFileSync('website/src/components/DiligenceReport.astro', 'utf8');
  const print = report.slice(report.indexOf('@media print'));
  assert.match(print, /:global\(\.native-figure:has\(\.chart-pyramid\)\) \{ break-inside: auto; page-break-inside: auto; \}/);
  assert.match(print, /:global\(\.chart-pyramid > svg\) \{ position: absolute; visibility: hidden; \}/);
  assert.match(print, /:global\(\.pyramid-print-layers\) \{ display: block !important;[^}]*font-size: 10pt;/);
  assert.match(print, /:global\(\.pyramid-print-layers > li\) \{[^}]*break-inside: avoid; page-break-inside: avoid;/);
});

test('font readiness remeasures existing charts before laying out range axes', () => {
  const source = readFileSync('website/src/components/FigureRenderer.astro', 'utf8');
  const callback = source.match(/document\.fonts\.ready\.then\(([\s\S]*?)\);\n  window\.addEventListener\('beforeprint'/)?.[1];
  assert.ok(callback);
  const calls = [];
  const onReady = new Function('renderAllCharts', 'layoutRangeAxes', `return (${callback});`)(
    options => calls.push(['render', options]), () => calls.push(['axes']),
  );
  onReady();
  assert.deepEqual(calls, [['render', { force: true }], ['axes']]);
});

test('measured SVG wrapping preserves complete mixed-script text at each layer width and font', () => {
  const source = readFileSync('website/src/components/FigureRenderer.astro', 'utf8');
  const start = source.indexOf('const createSvgTextWrapper =');
  assert(start >= 0, 'timeline and pyramid must share measured text wrapping');
  const helper = source.slice(start, source.indexOf('const renderTimeline =', start));
  const createWrapper = new Function('chartFont', `${helper}; return createSvgTextWrapper;`)({ family: 'test-font' });
  const attributes = new Map();
  let text = '';
  let removed = false;
  const measure = (value, size, weight) => Array.from(value).reduce(
    (width, character) => width + size * (/\p{Script=Han}/u.test(character) ? 1 : 0.55) * (weight / 400), 0,
  );
  const probe = {
    attr(key, value) { attributes.set(key, value); return this; },
    text(value) { text = value; return this; },
    node() { return { getComputedTextLength: () => measure(text, attributes.get('font-size'), attributes.get('font-weight')) }; },
    remove() { removed = true; },
  };
  const wrapper = createWrapper({ append: () => probe });
  for (const maxWidth of [40, 80, 160]) {
    for (const [fontSize, fontWeight] of [[10, 400], [14, 700]]) {
      for (const input of ['Mordor 2026 $28.13B CX services', '客户互动解决方案规模包含更宽的服务元素', '2026 年 $28.13B，包含 CX 和服务元素。', 'UninterruptedLongEnglishToken', '', '  ']) {
        const lines = wrapper.wrap(input, { fontSize, fontWeight, maxWidth });
        assert.equal(lines.join('').replace(/\s/gu, ''), input.replace(/\s/gu, ''));
        for (const line of lines) assert(measure(line, fontSize, fontWeight) <= maxWidth);
        assert.deepEqual(wrapper.wrap(input, { fontSize, fontWeight, maxWidth }), lines);
        const fitted = wrapper.fit(input, { fontSize, fontWeight, maxWidth });
        assert(measure(fitted, fontSize, fontWeight) <= maxWidth);
        if (measure(input, fontSize, fontWeight) <= maxWidth) assert.equal(fitted, input);
        else assert(fitted.endsWith('…'));
        for (const maxLines of [1, 2]) {
          const preview = wrapper.wrap(input, { fontSize, fontWeight, maxWidth, maxLines });
          assert(preview.length <= maxLines);
          for (const line of preview) assert(measure(line, fontSize, fontWeight) <= maxWidth);
          if (lines.length > maxLines) assert(preview.at(-1).endsWith('…'));
          else assert.deepEqual(preview, lines);
          assert.deepEqual(wrapper.wrap(input, { fontSize, fontWeight, maxWidth }), lines);
        }
      }
    }
  }
  wrapper.remove();
  assert.equal(removed, true);
});

test('flow and stack previews fit measured widths without removing complete tooltip data', () => {
  const source = readFileSync('website/src/components/FigureRenderer.astro', 'utf8');
  const flow = source.slice(source.indexOf('const renderFlow ='), source.indexOf('const firstNonEmpty ='));
  const stack = source.slice(source.indexOf('const renderStack ='), source.indexOf('const renderPyramid ='));
  for (const renderer of [flow, stack]) {
    assert.match(renderer, /createSvgTextWrapper\(svg\)/);
    assert.match(renderer, /textWrapper\.remove\(\)/);
  }
  assert.match(flow, /wrap\(node\.label, \{[^}]*maxWidth: cardW - textX \* 2, maxLines: 2/);
  assert.match(flow, /wrap\(node\.detail, \{[^}]*maxWidth: cardW - textX \* 2/);
  assert.match(flow, /tooltipHtml\(node\.label, \[safeText\(node\.displayValue \?\? node\.value\), \.\.\.figureValueNotes\(node\)\]\)/);
  assert.match(stack, /fit\(d\.label, \{[^}]*maxWidth: layerWidth\(index\) - 42 - badgeSize \* 2/);
  assert.match(stack, /fit\(d\.detail, \{[^}]*maxWidth: layerWidth\(index\) - 48/);
  assert.match(stack, /fit\(pill\.label, \{[^}]*maxWidth: pillW - 22/);
  assert.match(stack, /tooltipHtml\(d\.label, detailLines\(d\)\)/);
});

test('mobile table captions use the full block table width rather than an anonymous caption column', () => {
  const source = readFileSync('website/src/components/DataTable.astro', 'utf8');
  const mobile = source.slice(source.indexOf('@media (max-width: 700px)'));
  assert.match(mobile, /\.table-frame :global\(caption\) \{ display: block; width: 100%; \}/);
});

test('stack details retain complete ordered groups, duplicate labels, values and qualifications', () => {
  const data = { layers: [{
    label: 'Layer', detail: 'Primary context', description: 'Additional context', note: 'Not verified', unit: '%', value: 0,
    items: ['First item', { name: 'Named item', detail: 'Item detail' }],
    modules: ['First module', 'Second module', 'Third module', { label: 'Repeated', value: -2, unit: 'USD', note: 'Estimated' }, { label: 'Repeated', note: 'Different qualification' }],
    outputs: ['First output', 'Second output', 0, false],
  }] };
  const before = structuredClone(data);
  const [layer] = stackLayerDetails(data);
  assert.equal(layer.label, 'Layer');
  assert.deepEqual(layer.notes, ['0', 'Primary context', 'Additional context', 'Not verified', '%']);
  assert.deepEqual(layer.groups, [
    { key: 'items', entries: [['First item'], ['Named item', 'Item detail']] },
    { key: 'modules', entries: [['First module'], ['Second module'], ['Third module'], ['Repeated', '-2', 'Estimated', 'USD'], ['Repeated', 'Different qualification']] },
    { key: 'outputs', entries: [['First output'], ['Second output'], ['0'], ['false']] },
  ]);
  assert.deepEqual(data, before);
});

test('stack details preserve aliases, zero-valued labels and display values without fabricated group contents', () => {
  const layers = Object.freeze([
    Object.freeze({ name: 'Named layer', summary: 'Summary', modules: Object.freeze([{ displayValue: 'R$2mn', value: 2, unit: 'R$mn' }]) }),
    'Text layer', { label: 0, items: [null, '', { id: 'raw-id', context: 'Context' }] },
  ]);
  const result = stackLayerDetails({ items: layers });
  assert.deepEqual(result.map(layer => layer.label), ['Named layer', 'Text layer', '0']);
  assert.deepEqual(result[0].notes, ['Summary']);
  assert.deepEqual(result[0].groups[0].entries, [['R$2mn', 'R$mn']]);
  assert.deepEqual(result[2].groups[0].entries, [['raw-id', 'Context']]);
  assert.deepEqual(stackLayerDetails({ layers: [], items: layers }), []);
  assert.deepEqual(stackLayerDetails(null), []);
});

test('implicit flow details retain full qualifications without inventing explicit connections', () => {
  const data = { nodes: [{ id: 'a', label: 'A', value: 0, unit: 'USD', summary: 'Full summary', note: 'Not a forecast' }, { id: 'b', label: 'B' }] };
  const table = flowRelationshipTable(data, flowTopology(data), {
    nodeLabel: 'Node', connectionLabel: 'Connection', sourceLabel: 'Node / from', targetLabel: 'To', contextLabel: 'Context',
  });
  assert.equal(table.rows.length, 2);
  assert.deepEqual(table.rows.map(row => row.label), ['Node 1', 'Node 2']);
  assert.equal(table.rows[0].values[2], '0\nUSD\nFull summary\nNot a forecast');
  assert.equal(table.rows[1].values[1], null);
  assert.equal(Object.hasOwn(data, 'edges'), false);
});

test('report evidence links retain every declared reference in order without mutating the input', () => {
  const refs = Object.freeze(['CI005', 'CI006', 'CI010', 'CI011', 'CI015', 'CI016', 'CI020', 'CI021', 'CI022', 'CI005']);
  const result = claimRefs(Object.freeze({ claimRefs: refs }));
  assert.deepEqual(result, refs);
  assert.notEqual(result, refs);
  result.pop();
  assert.equal(refs.length, 10);
  assert.deepEqual(claimRefs({ claimRefs: ['CO001'] }), ['CO001']);
  for (const value of [null, undefined, 'CO001', {}, { claimRefs: null }]) {
    assert.deepEqual(claimRefs(value), []);
  }
});

test('company profiles use the uncapped evidence-reference projection', () => {
  const source = readFileSync('website/src/components/DiligenceReport.astro', 'utf8');
  assert.match(source, /<ClaimRefs refs=\{claimRefs\(companyProfile\)\} claims=\{claims\} sources=\{sources\}/);
});

test('flow sequences require every explicit connection to form the complete ordered chain', () => {
  const nodes = [{ id: 'a', label: 'First' }, { id: 'b', label: 'Second' }, { id: 'c', label: 'Third' }];
  assert.equal(flowTopology({ nodes }).sequence, true);
  assert.equal(flowTopology({ nodes, edges: [{ from: 'b', to: 'c' }, { source: 'First', target: 'Second' }] }).sequence, true);
  for (const edges of [
    [{ from: 'a', to: 'b' }],
    [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }],
    [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
    [{ from: 'a', to: 'b' }, { from: 'a', to: 'b' }],
    [{ from: 'a', to: 'a' }, { from: 'b', to: 'c' }],
  ]) {
    const topology = flowTopology({ nodes, edges });
    assert.equal(topology.sequence, false);
    assert.equal(topology.unresolved, false);
    assert.equal(topology.endpoints.length, edges.length);
  }
});

test('flow endpoints retain missing, ambiguous, alias and zero-valued identifiers without guessing', () => {
  const data = { nodes: [{ id: 0, label: 'Zero' }, { id: 'b', label: 'Shared' }, { id: 'c', label: 'Shared' }],
    edges: [{ from: 0, to: 'b' }, { from: 'Shared', to: 'missing' }, { from: '', to: null }, { source: 'c', target: 'Zero' }] };
  assert.deepEqual(flowTopology(data), { sequence: false, unresolved: true, endpoints: [
    { fromIndex: 0, toIndex: 1 }, { fromIndex: null, toIndex: null },
    { fromIndex: null, toIndex: null }, { fromIndex: 2, toIndex: 0 },
  ] });
  assert.equal(flowTopology({ nodes: [{ id: 'same' }, { id: 'same' }], edges: [{ from: 'same', to: 'same' }] }).unresolved, true);
});

test('relationship tables preserve all nodes, duplicate connections, context and raw unresolved endpoints', () => {
  const data = {
    nodes: [
      { id: 'a', label: 'First', value: 0, unit: 'USD', detail: 'Estimated.', note: 'Estimated.', context: 'Not revenue.', tone: 'warning' },
      { id: 'b', label: 'Second', description: 'Separate cohort.' },
      { id: 'isolated', label: 'Unconnected' },
    ],
    edges: [
      { from: 'a', to: 'b', label: 'First connection', note: '<b>Literal</b>' },
      { from: 'a', to: 'b', relationship: 'Second connection', value: -2, unit: '%' },
      { from: 'unknown', to: 'a', label: 'Unresolved source' },
      { source: 'b', target: 'a', label: 'Feedback' },
    ],
  };
  const before = structuredClone(data);
  [...data.nodes, ...data.edges].forEach(Object.freeze);
  Object.freeze(data.nodes);
  Object.freeze(data.edges);
  Object.freeze(data);
  const table = flowRelationshipTable(data, flowTopology(data),
    { nodeLabel: 'Node', connectionLabel: 'Connection', sourceLabel: 'Node / from', targetLabel: 'To', contextLabel: 'Context' });
  assert.deepEqual(table.columns, ['Node / from', 'To', 'Context']);
  assert.deepEqual(table.rows.map(row => row.label), ['Node 1', 'Node 2', 'Node 3', 'Connection 1', 'Connection 2', 'Connection 3', 'Connection 4']);
  assert.deepEqual(table.rows[0].values, [{ label: 'First [a]', tone: 'warning' }, null, '0\nUSD\nEstimated.\nNot revenue.']);
  assert.equal(table.rows[1].values[2], 'Separate cohort.');
  assert.equal(table.rows[2].values[0].label, 'Unconnected [isolated]');
  assert.deepEqual(table.rows[3].values, ['First [a]', 'Second [b]', 'First connection\n<b>Literal</b>']);
  assert.deepEqual(table.rows[4].values, ['First [a]', 'Second [b]', 'Second connection\n-2\n%']);
  assert.deepEqual(table.rows[5].values, ['unknown', 'First [a]', 'Unresolved source']);
  assert.deepEqual(table.rows[6].values, ['Second [b]', 'First [a]', 'Feedback']);
  assert.deepEqual(data, before);
});

test('flow topology resolves English label aliases before Chinese overlays without changing report data', () => {
  const data = { nodes: [{ label: 'First' }, { label: 'Second' }], edges: [{ from: 'First', to: 'Second', label: 'Relation' }] };
  const figure = Object.freeze({ type: 'flow', data: Object.freeze(data) });
  const before = structuredClone(figure);
  const prepared = withFlowTopology(figure);
  assert.equal(prepared.data, data);
  assert.deepEqual(figure, before);
  const translated = { ...prepared, data: { ...data, nodes: [{ label: '起点' }, { label: '终点' }],
    edges: [{ ...data.edges[0], label: '关系' }] } };
  assert.equal(translated._flowTopology.sequence, true);
  assert.equal(flowTopology(translated.data).unresolved, true);
  const table = flowRelationshipTable(translated.data, translated._flowTopology,
    { nodeLabel: '节点', connectionLabel: '连接', sourceLabel: '节点 / 起点', targetLabel: '终点', contextLabel: '说明' });
  assert.deepEqual(table.rows[2].values, ['起点', '终点', '关系']);
  const other = { type: 'bar', data: { items: [] } };
  assert.equal(withFlowTopology(other), other);
});

test('bar series retain every populated series and preserve existing item precedence', () => {
  const items = Object.freeze([{ label: 'Item', value: 1 }]);
  const points = Object.freeze([{ label: 'Point', value: 2 }]);
  const first = Object.freeze({ name: 'First', points });
  const second = Object.freeze({ label: 'Second', points: items });
  assert.equal(barSeries({ items, series: [first, second] })[0].points, items);
  assert.deepEqual(barSeries({ items: [], series: [{ points: [] }, first, second] }), [first, second]);
  for (const data of [undefined, {}, { series: [] }, { series: [null, { points: [] }] }]) {
    assert.deepEqual(barSeries(data), []);
  }
});

test('multi-series bar tables preserve duplicate labels, exact values, units, notes and tones', () => {
  const input = [
    { name: 'Money', unit: 'USD', points: [
      { label: 'Same', value: 0, note: 'Estimated.', context: 'Estimated.', tone: 'warning' },
      { label: 'Same', value: 1200, displayValue: '$1.2K', detail: 'Not recurring.', description: 'One period only.' },
    ] },
    { label: 'Rate', points: [
      { label: 'Same', value: -12.5, unit: '%', notes: '<em>Literal qualification</em>' },
      { label: 'Unknown', value: null },
    ] },
  ];
  const before = structuredClone(input);
  for (const group of input) {
    group.points.forEach(Object.freeze);
    Object.freeze(group.points);
    Object.freeze(group);
  }
  const table = barSeriesTable(Object.freeze(input), { valueLabel: 'Value', contextLabel: 'Context' });
  assert.deepEqual(table.columns, ['Value', 'Context']);
  assert.deepEqual(table.rows.map((row) => row.label), ['Money / Same', 'Money / Same', 'Rate / Same', 'Rate / Unknown']);
  assert.deepEqual(table.rows.map((row) => row.values[0].label), ['0', '$1.2K', '-12.5', '—']);
  assert.deepEqual(table.rows.map((row) => row.values[0].value), [0, 1200, -12.5, null]);
  assert.equal(table.rows[0].values[0].tone, 'warning');
  assert.equal(table.rows[0].values[1], 'USD\nEstimated.');
  assert.equal(table.rows[1].values[1], 'USD\nNot recurring.\nOne period only.');
  assert.equal(table.rows[2].values[1], '%\n<em>Literal qualification</em>');
  assert.equal(table.rows[3].values[1], null);
  assert.deepEqual(input, before);
  const unqualified = barSeriesTable([{ points: [{ value: 0 }, { label: 'Again', value: 2 }] }],
    { valueLabel: '数值', contextLabel: '说明' });
  assert.deepEqual(unqualified.columns, ['数值']);
  assert.equal(unqualified.rows[0].label, '#1 / #1');
  assert.ok(unqualified.rows.every((row) => row.values.length === 1));
});

for (const file of ['FigureRenderer.astro', 'DiligenceReport.astro']) {
  test(`figure caveats are not hidden by ${file} styles`, () => {
    const source = readFileSync(`website/src/components/${file}`, 'utf8');
    assert.equal(/\.figure-note[^{]*\{[^}]*\b(?:display:\s*none|visibility:\s*hidden)\b/.test(source), false,
      `${file}: figure approximation and evidence notes must remain visible`);
  });
}

test('KPI and range cards and tooltips retain every distinct qualification and unit without changing the input', () => {
  const cases = [
    [{ note: 'Illustrative FX only.' }, ['Illustrative FX only.']],
    [{ context: 'Unaudited.' }, ['Unaudited.']],
    [{ detail: 'Estimated.', context: 'Single geography.' }, ['Estimated.', 'Single geography.']],
    [{ detail: 'Estimated.', context: 'Estimated.' }, ['Estimated.']],
    [{ note: 'Provisional.', context: 'Current cohort only.' }, ['Provisional.', 'Current cohort only.']],
    [{ note: 'Annualized.', context: 'Annualized.' }, ['Annualized.']],
    [{ description: 'Estimated.', context: 'Estimated.' }, ['Estimated.']],
    [{ summary: 'Limited sample.', context: 'Limited sample.' }, ['Limited sample.']],
    [{ detail: '', description: 'Known scope.', context: 'Known scope.' }, ['Known scope.']],
    [{ detail: 'Other detail.', note: 'Known scope.', context: 'Known scope.' }, ['Other detail.', 'Known scope.']],
    [{ detail: 'Original detail.', context: '' }, ['Original detail.']],
    [{ detail: 'Original detail.', context: null }, ['Original detail.']],
    [{ context: '<b>Not markup</b> & a condition.' }, ['<b>Not markup</b> & a condition.']],
    [{ detail: 'Basis.', description: 'Definition.', note: 'Estimate.', notes: 'Period.', context: 'Scope.', unit: 'R$mn' },
      ['Basis.', 'Definition.', 'Estimate.', 'Period.', 'Scope.', 'R$mn']],
    [{ value: -139.6, note: 'Loss.', context: 'R$mn', unit: 'R$mn' }, ['Loss.', 'R$mn']],
    [{ low: -20, mid: 80, high: 180, note: 'Not shareholder returns.', unit: '%' }, ['Not shareholder returns.', '%']],
    [{ low: -20, high: 180, detail: 'Selected scenarios.', note: 'Not a floor.', context: 'No horizon.', unit: '%' },
      ['Selected scenarios.', 'Not a floor.', 'No horizon.', '%']],
    [{ value: 0, note: '', notes: ' ', context: null, unit: '%' }, ['%']],
    [{}, []],
  ];
  for (const [item, expected] of cases) {
    const before = structuredClone(item);
    assert.deepEqual(figureValueNotes(Object.freeze(item)), expected);
    assert.deepEqual(item, before);
    const normalized = { ...item, detail: figureDetail(item) ?? item.summary };
    assert.deepEqual(figureValueNotes(Object.freeze(normalized)), expected);
  }
});

test('range tones are resolved before localization without overriding authored tones', () => {
  const cases = [
    [{ label: 'Bear case', low: 0.4, mid: 0.5, high: 0.6 }, 'risk'],
    [{ label: 'STRESS scenario' }, 'risk'],
    [{ label: 'Bull case' }, 'positive'],
    [{ label: 'Base case' }, 'neutral'],
    [{ label: 'Current reported round' }, 'neutral'],
    [{ label: 'Base case', tone: 'warning' }, 'warning'],
    [{ label: 'Bear case', tone: 'neutral' }, 'neutral'],
    [{ label: 'Bull case', tone: 'opportunity' }, 'opportunity'],
    [{ label: 'Plant-based market', tone: 'adverse' }, 'adverse'],
    [{ label: 'Bear case', tone: '' }, 'risk'],
    [{ label: 'Bull case', tone: null }, 'positive'],
    [{}, 'neutral'],
  ];
  const items = cases.map(([item]) => Object.freeze(item));
  const figure = Object.freeze({ id: 'F1', type: 'range', data: Object.freeze({ items: Object.freeze(items) }) });
  const before = structuredClone(figure);
  const prepared = withRangeTones(figure);
  assert.deepEqual(prepared.data.items.map((item) => item.tone), cases.map(([, tone]) => tone));
  assert.deepEqual(figure, before);
  prepared.data.items.forEach((item, index) => {
    const { tone, ...rest } = item;
    const { tone: originalTone, ...original } = items[index];
    assert.deepEqual(rest, original);
    if (originalTone) assert.equal(item, items[index]);
  });
  const translated = { ...prepared, data: { items: prepared.data.items.map((item) => ({ ...item, label: 'Translated display label' })) } };
  assert.deepEqual(withRangeTones(translated), translated);
  assert.deepEqual(withRangeTones(prepared), prepared);
  for (const other of [{ type: 'bar', data: { items } }, { type: 'range' }, { type: 'range', data: { nodes: items } }]) {
    assert.equal(withRangeTones(other), other);
  }
});

test('chart units are compared conservatively without inferring units from labels', () => {
  const cases = [
    [[{ unit: 'businesses' }, { unit: 'USD' }], true],
    [[{ unit: 'USD' }, { unit: ' USD ' }], false],
    [[{ unit: 'm' }, { unit: 'M' }], true],
    [[{ unit: 'clients' }, { unit: 'clients (estimated)' }], true],
    [[{ unit: 'businesses' }, { unit: 'businesses' }], false],
    [[{ unit: 'USD' }, { unit: null }, {}], false],
    [[{ unit: 'clients' }, {}, { unit: 'USD' }], true],
    [[{ label: 'Customers' }, { label: 'Revenue', unit: '' }], false],
    [[], false],
  ];
  for (const [items, expected] of cases) {
    const before = structuredClone(items);
    assert.equal(figureUnitsDiffer(Object.freeze(items.map(Object.freeze))), expected);
    assert.deepEqual(items, before);
    const translated = items.map((item) => ({ ...item, label: 'Translated label' }));
    assert.equal(figureUnitsDiffer(translated), expected);
  }
});

test('funnel tables retain original stage values without inferring ratios or comparability', () => {
  for (const units of [['people', 'people'], ['people', 'USD'], [undefined, undefined], ['people', undefined]]) {
    const items = Object.freeze([
      Object.freeze({ label: 'Repeated', value: 100, unit: units[0], detail: 'Only one period.', note: '<b>Literal</b>', context: 'Estimated.' }),
      Object.freeze({ label: 'Repeated', value: 500, unit: units[1], note: 'Different population.', tone: 'warning' }),
      Object.freeze({ name: 'Zero', value: 0 }),
      Object.freeze({ label: 'Authored percentage', value: 40, displayValue: '40%', unit: '%', note: 'Company-reported rate.' }),
    ]);
    const data = Object.freeze({ items });
    const before = structuredClone(data);
    const table = funnelStageTable(data, { valueLabel: 'Value', contextLabel: 'Context' });
    assert.deepEqual(table.columns, ['Value', 'Context']);
    assert.deepEqual(table.rows.map(row => row.label), ['Repeated', 'Repeated', 'Zero', 'Authored percentage']);
    assert.deepEqual(table.rows.map(row => row.values[0].label), ['100', '500', '0', '40%']);
    assert.deepEqual(table.rows.map(row => row.values[0].value), [100, 500, 0, 40]);
    assert.equal(table.rows[0].values[1], [units[0], 'Only one period.', '<b>Literal</b>', 'Estimated.'].filter(Boolean).join('\n'));
    assert.equal(table.rows[1].values[0].tone, 'warning');
    assert.equal(table.rows[2].values[1], null);
    assert.deepEqual(data, before);
  }
});

test('funnel tables preserve populated-item precedence and every fallback series with its units', () => {
  const items = [{ label: 'Primary', value: 0 }];
  const series = [{ name: 'Empty', points: [] },
    { name: 'Cohort A', unit: 'accounts', points: [{ label: 'Repeat', value: 20 }, { label: 'Repeat', value: 10, unit: 'people' }] },
    { label: 'Cohort B', unit: 'USD', points: [{ label: 'Repeat', value: 30 }] }];
  const labels = { valueLabel: 'Value', contextLabel: 'Context' };
  const data = { items: [], series };
  const before = structuredClone(data);
  assert.deepEqual(funnelStageTable({ items, series }, labels).rows, [{ label: 'Primary', values: [{ label: '0', value: 0, detail: '' }] }]);
  const table = funnelStageTable(data, labels);
  assert.deepEqual(table.rows.map(row => row.label), ['Cohort A / Repeat', 'Cohort A / Repeat', 'Cohort B / Repeat']);
  assert.deepEqual(table.rows.map(row => row.values[1]), ['accounts', 'people', 'USD']);
  assert.deepEqual(data, before);
  for (const empty of [undefined, null, {}, { items: [] }, { series: [] }]) assert.deepEqual(funnelStageTable(empty, labels).rows, []);
});

test('funnel tables localize labels without changing values, units, order or authored rates', () => {
  const data = { items: [{ label: 'Reached', value: 100, unit: 'accounts' }, { label: 'Converted', value: 20, displayValue: '20%', note: 'Reported.' }] };
  const en = funnelStageTable(data, { valueLabel: 'Value', contextLabel: 'Context' });
  const zh = funnelStageTable({ items: [{ ...data.items[0], label: '已触达' }, { ...data.items[1], label: '已转化', note: '据报道。' }] },
    { valueLabel: '数值', contextLabel: '说明' });
  assert.deepEqual(zh.columns, ['数值', '说明']);
  assert.deepEqual(zh.rows.map(row => row.values[0].value), en.rows.map(row => row.values[0].value));
  assert.deepEqual(zh.rows.map(row => row.values[0].label), en.rows.map(row => row.values[0].label));
  assert.equal(zh.rows[0].values[1], 'accounts');
  assert.equal(zh.rows[1].values[1], '据报道。');
});

test('funnel qualifications preserve distinct text, aliases and literal markup without duplication', () => {
  const cases = [
    [{ note: 'Highly uncertain; actual count not disclosed.' }, ['Highly uncertain; actual count not disclosed.']],
    [{ description: 'Company-reported.' }, ['Company-reported.']],
    [{ detail: 'Estimated.', description: 'Single cohort.', note: 'Unaudited.' }, ['Estimated.', 'Single cohort.', 'Unaudited.']],
    [{ detail: '', description: 'Known scope.', notes: 'May exclude inactive users.' }, ['Known scope.', 'May exclude inactive users.']],
    [{ detail: 'Estimated.', note: 'Estimated.', context: 'Estimated.' }, ['Estimated.']],
    [{ details: 'One year only.', context: 'Not recurring revenue.' }, ['One year only.', 'Not recurring revenue.']],
    [{ detail: 'Reported total.', valueNote: 'Self-reported; no audit.' }, ['Reported total.', 'Self-reported; no audit.']],
    [{ note: 'Unaudited.', valueNote: 'Unaudited.' }, ['Unaudited.']],
    [{ valueNote: '<em>Literal qualification</em>' }, ['<em>Literal qualification</em>']],
    [{ valueNote: ['Unsupported array'] }, []],
    [{ valueNote: { label: 'Unsupported object' } }, []],
    [{ valueNote: 0 }, []],
    [{ note: '<em>Not markup</em> & a qualification.' }, ['<em>Not markup</em> & a qualification.']],
    [{ note: '', description: null, context: ' \n ' }, []],
    [{ value: 0, unit: 'USD' }, []],
  ];
  for (const [item, expected] of cases) {
    const before = structuredClone(item);
    assert.deepEqual(figureItemNotes(Object.freeze(item)), expected);
    assert.deepEqual(item, before);
  }
});

test('all supported funnel qualifications are translatable in both data shapes, but units stay preserved', () => {
  for (const prefix of [
    ['figures', 0, 'data', 'items', 0],
    ['figures', 0, 'data', 'series', 0, 'points', 0],
  ]) {
    for (const field of ['detail', 'description', 'details', 'note', 'notes', 'context', 'valueNote']) {
      assert.deepEqual(figureItemNotes({ [field]: 'Qualification.' }), ['Qualification.']);
      assert.equal(isTranslatableLeaf([...prefix, field], TRANSLATE_PATHS.fullReport), true);
    }
    for (const field of ['value', 'displayValue', 'unit', 'claimRefs']) {
      assert.equal(isTranslatableLeaf([...prefix, field], TRANSLATE_PATHS.fullReport), false);
    }
  }
});

test('funnel value notes remain visible and in tooltips without changing numeric values', () => {
  const point = Object.freeze({ label: 'Devices', value: 170000000, detail: 'Reported total.', valueNote: 'Self-reported; no audit.' });
  for (const data of [{ items: [point] }, { series: [{ name: 'Deployment', points: [point] }] }]) {
    const before = structuredClone(data);
    const table = funnelStageTable(data, { valueLabel: 'Value', contextLabel: 'Context' });
    assert.equal(table.rows[0].values[0].value, 170000000);
    assert.equal(table.rows[0].values[0].label, '170000000');
    assert.equal(table.rows[0].values[0].detail, 'Reported total.\nSelf-reported; no audit.');
    assert.equal(table.rows[0].values[1], 'Reported total.\nSelf-reported; no audit.');
    assert.deepEqual(data, before);
  }
});

test('translation sweep invalidates cached passes when checker or whitelist code changes', () => {
  mkdirSync('.research-cache', { recursive: true });
  const root = mkdtempSync(join('.research-cache', 'translation-cache-test-'));
  try {
    const scripts = join(root, '.agents/skills/translate-zh/scripts');
    const report = join(root, 'reports/20990101000000-cache-test');
    mkdirSync(scripts, { recursive: true });
    mkdirSync(report, { recursive: true });
    for (const name of ['check-translations.mjs', 'check-translation.mjs', 'whitelist.mjs']) {
      writeFileSync(join(scripts, name), readFileSync(`.agents/skills/translate-zh/scripts/${name}`));
    }
    const whitelistFile = join(scripts, 'whitelist.mjs');
    const whitelist = readFileSync(whitelistFile, 'utf8');
    const oldWhitelist = whitelist.replace("  'figures/[]/data/items/[]/note',\n", '');
    assert.notEqual(oldWhitelist, whitelist);
    writeFileSync(whitelistFile, oldWhitelist);
    const english = { artifact: 'full-report', figures: [{ data: { items: [
      { label: 'Entry', value: 100, note: 'Important disclosure remains unavailable.' },
    ] } }] };
    const chinese = structuredClone(english);
    chinese.figures[0].data.items[0].label = '入口';
    writeFileSync(join(report, 'full-report.yaml'), JSON.stringify(english));
    writeFileSync(join(report, 'full-report.zh.yaml'), JSON.stringify(chinese));
    const sweep = () => spawnSync(process.execPath, [join(scripts, 'check-translations.mjs'), '--strict'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, CHECK_TRANSLATION_NO_CACHE: '0' },
    });
    const first = sweep();
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /1 re-checked, 0 cached/);
    const cached = sweep();
    assert.equal(cached.status, 0, cached.stderr);
    assert.match(cached.stdout, /0 re-checked, 1 cached/);
    const cacheFile = join(root, '.cache/check-translations.json');
    const oldCache = readFileSync(cacheFile, 'utf8');
    writeFileSync(whitelistFile, whitelist);
    const rejected = sweep();
    assert.equal(rejected.status, 1, rejected.stdout);
    assert.match(rejected.stderr, /figures\/0\/data\/items\/0\/note: translation is identical/);
    assert.equal(readFileSync(cacheFile, 'utf8'), oldCache);
    chinese.figures[0].data.items[0].note = '重要信息仍未公开。';
    writeFileSync(join(report, 'full-report.zh.yaml'), JSON.stringify(chinese));
    const repaired = sweep();
    assert.equal(repaired.status, 0, repaired.stderr);
    assert.match(repaired.stdout, /1 re-checked, 0 cached/);
    for (const name of ['check-translation.mjs', 'check-translations.mjs']) {
      const before = JSON.parse(readFileSync(cacheFile, 'utf8')).version;
      const file = join(scripts, name);
      writeFileSync(file, `${readFileSync(file, 'utf8')}\n// Regression fixture change.\n`);
      const result = sweep();
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /1 re-checked, 0 cached/);
      assert.notEqual(JSON.parse(readFileSync(cacheFile, 'utf8')).version, before);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('authoring-instruction checks reject leaked workflow directives in public prose', () => {
  const directives = [
    'The first pass through the chapter should answer the mission questions directly.',
    'The middle section should connect the claims to the tables so the reader can see the evidence.',
    'Refer to that chronology, but do not copy Company Overview claim ids.',
    ' \tDo not copy Company Overview claim IDs.',
    'If Financials needs a funding fact, mint a local Financials claim with its own sourceRefs.',
    'MINT A LOCAL COMPANY OVERVIEW CLAIM WITH ITS OWN SOURCEREFS.',
    'The middle section\nshould connect the claims\tto the tables.',
  ];
  for (const body of directives) {
    const doc = { sections: [{ body }] };
    const before = structuredClone(doc);
    const { errors } = checkAuthoringInstructions(doc, { path: 'chapter.yaml' });
    assert.equal(errors.length, 1, body);
    assert.equal(errors[0].path, 'chapter.yaml.sections[0].body');
    assert.equal(errors[0].dimension, 'authoringInstructions');
    assert.match(errors[0].fix, /source-backed/);
    assert.deepEqual(doc, before);
  }
  assert.equal(KNOWN_DIMENSIONS.has('authoringInstructions'), true);
  assert.equal(WARNING_DIMENSIONS.has('authoringInstructions'), false);
});

test('authoring-instruction checks cover assembled blocks, tables, figures and cover text', () => {
  const text = 'The middle section should connect the claims to the tables.';
  const doc = {
    chapters: [{ sections: [{ blocks: [{ body: text }, { items: [text] }] }] }],
    tables: [{ notes: text, rows: [[text]] }],
    figures: [{ summary: text, data: { nodes: [{ detail: text }] } }],
    summary: { headline: text, topRisks: [text] },
    coverFacts: [{ label: text }],
    companyProfile: { summary: text },
    appendices: [{ blocks: [{ body: text }] }],
  };
  const { errors } = checkAuthoringInstructions(doc);
  assert.equal(errors.length, 11);
  assert.equal(new Set(errors.map((error) => error.path)).size, 11);
});

test('authoring-instruction checks preserve analytical prose and research provenance', () => {
  const text = 'The first pass through the chapter should answer the mission questions directly.';
  const doc = {
    chapter: { summary: 'This chapter evaluates financing and customer concentration.' },
    sections: [{ body: 'Investors should request audited revenue, claims data, and customer references. The first pass through the production line controls yield.' }],
    tables: [
      { notes: 'Claims in this table refer to warranty compensation, not marketing assertions.' },
      { notes: 'Cash on hand and monthly burn rate are the most critical undisclosed financial items in this table; runway and capital adequacy cannot be independently assessed without them. The Company Overview chapter contains the round-by-round funding chronology; financing facts here are local Financials claims minted independently and do not copy Company Overview claim IDs.' },
      { notes: 'This table refers to the capital-formation chronology documented in Chapter 1 (Company Overview) for context; all funding claims here are independently minted local Financials claims with their own sourceRefs and do not copy Company Overview claim ids. Every metric is either third-party-reported with low confidence or entirely unavailable from public sources.' },
      { notes: 'Capital structure reconstructed from press releases, news articles, and S&P Capital IQ transaction data. No audited financial statements are available. Burn and runway figures are estimates derived from headcount data only. Refer to Company Overview chapter for full funding chronology; claims in this table mint local Financials claim IDs and do not copy Company Overview claim IDs.' },
    ],
    figures: [{ summary: 'The service connects insurance claims to the customer record.' }],
    localEvidence: {
      sources: [{ keyQuote: text }],
      researchQuestions: [{ question: text }],
    },
    sources: [{ keyQuote: text }],
    acknowledgedWarnings: [{ reason: text }],
  };
  assert.deepEqual(checkAuthoringInstructions(doc).errors, []);
  assert.deepEqual(checkAuthoringInstructions(null).errors, []);
});

test('authoring-instruction chapter failures cannot be acknowledged away', () => {
  const root = mkdtempSync(join(tmpdir(), 'authoring-instruction-check-'));
  const folder = join(root, '20260925000000-authoring-instructions');
  try {
    mkdirSync(folder);
    writeFileSync(join(folder, '01-company-overview.yaml'), yaml.dump({
      schemaVersion: 'report-v2', artifact: 'company-overview',
      slug: 'authoring-instructions', runDate: '2026-09-25',
      company: { name: 'Authoring instructions fixture' },
      chapter: { number: 1, title: 'Company Overview', summary: 'Isolated content-gate fixture.' },
      sections: [{
        id: 'analysis', title: 'Analysis',
        body: 'The first pass through the chapter should answer the mission questions directly.',
        claimRefs: [],
      }],
      tables: [], figures: [],
      localEvidence: { sources: [], claims: [], searchQueries: [], researchQuestions: [], gaps: [] },
      acknowledgedWarnings: [{
        dimension: 'authoringInstructions',
        reason: 'This fixture attempts to acknowledge a hard content failure.',
      }],
    }));
    for (const flags of [[], ['--strict']]) {
      const result = spawnSync(process.execPath, [
        '.agents/skills/startup-research/scripts/check-chapter.mjs',
        folder, '01-company-overview.yaml', '--format', 'json', ...flags,
      ], { encoding: 'utf8' });
      assert.equal(result.status, 1, result.stderr);
      const output = JSON.parse(result.stdout);
      const issues = output.issues.filter((issue) => issue.dimension === 'authoringInstructions');
      assert.equal(issues.length, 1);
      assert.ok(output.summary.failedDimensions.includes('authoringInstructions'));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('figure detail aliases preserve source text and existing precedence', () => {
  for (const [item, expected] of [
    [{ detail: 'Primary detail', description: 'Description', summary: 'Summary' }, 'Primary detail'],
    [{ description: 'Remaining manual touches become work queues.' }, 'Remaining manual touches become work queues.'],
    [{ detail: null, description: '人工介入率', summary: 'Summary' }, '人工介入率'],
    [{ summary: 'Do not add another visible field to flow or bar charts' }, undefined],
    [{ detail: '', description: 'Do not override an explicit blank' }, ''],
    [{}, undefined],
  ]) assert.equal(figureDetail(Object.freeze(item)), expected);
});

const clinicalGlossaryShell = 'Show glossary\n\nSearch for terms\n\nHide glossary\n\n'
  + 'Study record managers: refer to the Data Element Definitions if submitting registration or results information.';
const federalRegisterAccessText = 'Due to aggressive automated scraping of FederalRegister.gov and eCFR.gov,\n'
  + 'programmatic access to these sites is limited to access to our extensive\ndeveloper APIs. Please visit\n\n'
  + 'FederalRegister.gov API\n\ndocumentation or\n\neCFR.gov API\n\ndocumentation to learn more about how to access the API.\n\n'
  + 'Your request has been flagged as potentially automated. If you are human user\n'
  + 'receiving this message, please complete the CAPTCHA (bot test) below and\n'
  + 'click "Request Access". You may occassionally be asked to complete the\n'
  + 'CAPTCHA again, this is normal and part of our security measures.\n\n'
  + 'An official website of the United States government.\n\n'
  + 'If you experiencing issues with the CAPTCHA or want to request a wider IP range,\n'
  + 'you can use the "Site Help" button found in the lower, right of this page\nto make a request.';
const federalRegisterAccessBodies = [
  federalRegisterAccessText,
  `<html><head><title>Federal Register :: Request Access</title></head><body>${federalRegisterAccessText}</body></html>`,
  `Title: Federal Register :: Request Access\n\nURL Source: https://www.federalregister.gov/documents/2026/02/12/2026-02866/revision\n\nMarkdown Content:\n${federalRegisterAccessText}`,
  `Title:\n\nURL Source: https://www.federalregister.gov/documents/2026/02/12/2026-02866/revision\n\nWarning: This is a cached snapshot of the original page, consider retry with caching opt-out.\n\nMarkdown Content:\n${federalRegisterAccessText}`,
  `<html><body><!-- BEGIN WAYBACK TOOLBAR INSERT --><div id="wm-ipp-base">Wayback Machine</div><!-- END WAYBACK TOOLBAR INSERT -->${federalRegisterAccessText}</body></html>`,
];
const loginLockoutText = 'After three unsuccessful trials, for your security,\n'
  + 'your access has to be interrupted for 10 minutes.\n\n'
  + 'Many thanks for your appreciated understanding.\n'
  + 'Please contact us for any assistance at [email protected].';
const loginLockoutBodies = [
  loginLockoutText,
  `<html><head><title>Example Company Org Chart</title></head><body>${loginLockoutText}<a>Close</a></body></html>`,
  `Title: Example Company Org Chart\n\nURL Source: https://example.com/org-chart\n\nMarkdown Content:\n${loginLockoutText}`,
  `Title:\n\nURL Source: https://example.com/org-chart\n\nWarning: This is a cached snapshot of the original page, consider retry with caching opt-out.\n\nMarkdown Content:\n${loginLockoutText}`,
  `<html><body><!-- BEGIN WAYBACK TOOLBAR INSERT --><div id="wm-ipp-base">Wayback Machine</div><!-- END WAYBACK TOOLBAR INSERT -->${loginLockoutText}</body></html>`,
  loginLockoutText.replace('[email protected]', 'support@example.com'),
];
const loginLockoutChromeBody = `<html><head><title>Example Company Org Chart</title></head><body><nav>Companies Industries Pricing</nav><main><article><p>${loginLockoutText}</p></article></main><footer>Terms Privacy Contact</footer></body></html>`;
const orgChartControlText = 'Search the org chart\n\nPlease certify that all the modifications are exact';
const orgChartControlBodies = [
  orgChartControlText,
  `<html><head><title>Org chart</title></head><body>${orgChartControlText}</body></html>`,
  `Title: Org chart\n\nURL Source: https://example.com/org-chart\n\nMarkdown Content:\n${orgChartControlText}`,
];
const clientBlockedText = 'example.com is blocked\n\nThis page has been blocked by Chrome\n\n'
  + 'ERR_BLOCKED_BY_CLIENT\n\nThis page has been blocked by Chrome';
const clientBlockedBodies = [
  clientBlockedText,
  'This page has been blocked by Chrome\n\nERR_BLOCKED_BY_CLIENT',
  `<html><head><title>example.com</title></head><body><h1>example.com is blocked</h1><p>This page has been blocked by Chrome</p><div>ERR_BLOCKED_BY_CLIENT</div></body></html>`,
  `Title: example.com\n\nURL Source: https://example.com/company\n\nMarkdown Content:\n## ${clientBlockedText}`,
  `Title: example.com\n\nURL Source: https://example.com/company\n\nWarning: This is a cached snapshot of the original page, consider retry with caching opt-out.\n\nMarkdown Content:\n## ${clientBlockedText}`,
  `<html><body><!-- BEGIN WAYBACK TOOLBAR INSERT --><div id="wm-ipp-base">Wayback Machine: August 10, 2026</div><!-- END WAYBACK TOOLBAR INSERT -->${clientBlockedText}</body></html>`,
];
const clinicalTrialShellBodies = [
  `<html><head><title>ClinicalTrials.gov</title></head><body>${clinicalGlossaryShell}</body></html>`,
  '<html><head><title>ClinicalTrials.gov</title></head><body>Show glossary</body></html>',
  'ClinicalTrials.gov\n\nShow glossary',
  `ClinicalTrials.gov\n\n${clinicalGlossaryShell}`,
  'Title: ClinicalTrials.gov\n\nURL Source: https://clinicaltrials.gov/study/NCT00000001\n\nMarkdown Content:\nShow glossary',
  `Title: ClinicalTrials.gov\n\nURL Source: https://clinicaltrials.gov/study/NCT00000001\n\nPublished Time: 2026-04-16\n\nMarkdown Content:\n${clinicalGlossaryShell}`,
  `<html><head><title>ClinicalTrials.gov</title></head><body><!-- BEGIN WAYBACK TOOLBAR INSERT --><div id="wm-ipp-base">Wayback Machine: April 16, 2026</div><!-- END WAYBACK TOOLBAR INSERT -->${clinicalGlossaryShell}</body></html>`,
];

const notFoundTitleBodies = [
  '<html><head><title>404 | Page Not Found</title></head><body>Manage your tracker preferences.<h1>We can\'t find the page you\'re looking for.</h1><nav>Newsletters Careers Privacy policy</nav></body></html>',
  "Title: 404 | Page Not Found\n\nURL Source: https://example.com/missing-article\n\nMarkdown Content:\nManage your tracker preferences.\n\nWe can't find the page you're looking for.\n\nNewsletters Careers Privacy policy",
  '<html><head><title>DO NOT DELETE - 404 Page</title></head><body><nav>Markets Business Investing Tech</nav><h1>We are sorry, the page you were looking for cannot be found.</h1><footer>Newsletters Subscribe Privacy</footer></body></html>',
  'Title: DO NOT DELETE - 404 Page\n\nURL Source: https://example.com/missing-article\n\nPublished Time: 2018-04-05T15:43:23+0000\n\nMarkdown Content:\nMarkets Business Investing Tech\n\nWe are sorry, the page you were looking for cannot be found.\n\nNewsletters Subscribe Privacy',
];
const redirectShellBodies = [
  'You are now being redirected to shortly.....',
  '<html><head><title>Company biography</title></head><body>You are now being redirected to shortly.....</body></html>',
  'Title: Company biography\n\nURL Source: https://example.com/biography.pdf\n\nMarkdown Content:\nYou are now being redirected to shortly.....',
];
const signupShellBodies = [
  'New to Earnings Whispers?\n\nCreate FREE account to continue.',
  'Create FREE account to continue.',
  '<html><head><title>Earnings Whispers</title></head><body>New to Earnings Whispers?<p>Create FREE account to continue.</p></body></html>',
  'Title: Earnings Whispers\n\nURL Source: https://example.com/earnings\n\nMarkdown Content:\nNew to Earnings Whispers?\n\nCreate FREE account to continue.',
];
const signupChromeBody = '<html><head><title>Earnings article</title></head><body><nav>Calendar Research Prices</nav><form>Sign In <label>Email Address</label><input type="email"><label>Password</label><input type="password"></form><main><article><h5>New to Earnings Whispers?</h5><p>Create <strong>FREE</strong> account to continue.</p></article></main><footer>Copyright Terms Privacy</footer></body></html>';
const trackingPixelBodies = [
  'A 1x1 image, likely be a tacker probe',
  '<html><head><title>Tracking image</title></head><body>A 1x1 image, likely be a tracker probe.</body></html>',
  'Title: https://match.adsrvr.org/track/cmf/generic\n\nURL Source: https://example.com/article\n\nWarning: This is a cached snapshot of the original page, consider retry with caching opt-out.\n\nMarkdown Content:\nA 1x1 image, likely be a tacker probe',
  'Title: Tracking image\n\nURL Source: https://example.com/article\n\nPublished Time: 2026-02-10\n\nWarning: This is a cached snapshot of the original page, consider retry with caching opt-out.\n\nMarkdown Content:\nA 1x1 image, likely be a tracker probe',
  '<html><body><!-- BEGIN WAYBACK TOOLBAR INSERT --><div id="wm-ipp-base">Wayback Machine: February 10, 2026</div><!-- END WAYBACK TOOLBAR INSERT -->A 1x1 image, likely be a tacker probe</body></html>',
];
const financialRegistryShellBodies = [
  'Skip to navigation',
  'Skip to main content\nSkip to navigation',
  'BrokerCheck - Find a broker, investment or financial advisor',
  '<html><head><title>IAPD - Investment Adviser Public Disclosure - Homepage</title></head><body><a href="#main">Skip to main content</a><a href="#navigation">Skip to navigation</a><app-root></app-root><script src="main.js"></script></body></html>',
  '<html><head><title>BrokerCheck - Find a broker, investment or financial advisor</title></head><body><bc-root></bc-root><script src="main.js"></script></body></html>',
  'Title: IAPD - Investment Adviser Public Disclosure\n\nURL Source: https://adviserinfo.sec.gov/firm/summary/299398\n\nMarkdown Content:\nSkip to navigation',
  'Title: BrokerCheck - Find a broker, investment or financial advisor\n\nURL Source: https://brokercheck.finra.org/firm/summary/299398\n\nMarkdown Content:\nBrokerCheck - Find a broker, investment or financial advisor',
  '<html><head><title>BrokerCheck - Find a broker, investment or financial advisor</title></head><body><!-- BEGIN WAYBACK TOOLBAR INSERT --><div id="wm-ipp-base">Wayback Machine: June 25, 2026</div><!-- END WAYBACK TOOLBAR INSERT --><bc-root></bc-root></body></html>',
];
const waybackBanner = 'The Wayback Machine - https://web.archive.org/web/20260825120613/https://example.com/financials';
const waybackShellBodies = [
  waybackBanner,
  'Wayback Machine',
  `<html><head><title>Wayback Machine</title></head><body><div id="wm-ipp-print">${waybackBanner}</div></body></html>`,
  `<html><head><title>Wayback Machine</title></head><body><!-- BEGIN WAYBACK TOOLBAR INSERT --><div id="wm-ipp-base">21 captures</div><div id="wm-ipp-print">${waybackBanner}</div><!-- END WAYBACK TOOLBAR INSERT --><iframe id="playback" src="https://web.archive.org/web/20260825120613if_/https://example.com/financials"></iframe><script>window.playback = true;</script></body></html>`,
  '<html><head><title>Wayback Machine</title></head><body><iframe id="playback"></iframe></body></html>',
  `Title: Wayback Machine\n\nURL Source: https://web.archive.org/web/20260825120613/https://example.com/financials\n\nMarkdown Content:\n${waybackBanner}`,
  'Title: Wayback Machine\n\nURL Source: https://example.com/financials\n\nWarning: This is a cached snapshot of the original page, consider retry with caching opt-out.\n\nMarkdown Content:\n',
];
const archiveRedirectText = 'Loading...\n\nhttps://example.com/article |\n17:11:17 January 07, 2026\n\n'
  + 'Got an HTTP 302 response at crawl time\n\nRedirecting to...\n\nhttps://example.com/login\n\nImpatient?';
const archiveRedirectBodies = [
  archiveRedirectText,
  `<html><body>${archiveRedirectText}</body></html>`,
  `<html><body><nav>Internet Archive Texts Video Audio Donate</nav><section><div id="error"><script>location.href = "/login";</script>${archiveRedirectText}</div></section><div id="errorBorder"></div><footer>The Wayback Machine is an initiative of the Internet Archive.</footer></body></html>`,
  `Title:\n\nURL Source: https://example.com/article\n\nMarkdown Content:\n${archiveRedirectText}`,
];
const emptyHtmlBodies = [
  '<!DOCTYPE html><html><head><title></title><script>window.challenge = true;</script></head><body><div id="challenge-container"></div><script>window.reload = true;</script><noscript>JavaScript is disabled. Verify that you are not a robot.</noscript></body></html>',
  '<html><head><title>Company profile</title></head><body><app-root></app-root></body></html>',
  '<html><head><style>body { color: black; }</style></head><body> \n </body></html>',
  'Title: Company profile\n\nURL Source: https://example.com/profile\n\nMarkdown Content:\n',
];
const articleNotFoundText = '404: The article you are looking for cannot be found.';
const articleNotFoundBodies = [
  articleNotFoundText,
  `<html><head><title>Business News and Technology</title></head><body><nav>News Technology Subscribe</nav><main><h1><span>404:</span> The article you are looking for cannot be found.</h1><a>Back to home</a></main><footer>Privacy Terms</footer></body></html>`,
  `Title: Business News and Technology\n\nURL Source: https://example.com/article\n\nMarkdown Content:\n[Subscribe](https://example.com/subscribe)\n\n#### News\n\n# ${articleNotFoundText}\n\n[Back to home](https://example.com/)\n\n#### Technology\n\nPrivacy Terms`,
];
const accessErrorBodies = [
  '<html><head><title>Client Challenge</title></head><body>A required part of this site couldn’t load.</body></html>',
  "Title:\n\nURL Source: https://example.com/thread\n\nWarning: Target URL returned error 403: Forbidden\n\nMarkdown Content:\nYou've been blocked by network security.",
  'Title: Vercel Security Checkpoint\n\nURL Source: https://example.com/page\n\nWarning: Target URL returned error 429: Too Many Requests\n\nMarkdown Content:\nVercel Security Checkpoint',
  '<html><head><title>页面未找到</title></head><body><h1>404</h1><p>没有找到此种页面</p></body></html>',
  '404\n\n没有找到此种页面',
  '<html><title>404 - Page Not Found</title><body>This page is unavailable.</body></html>',
  ...notFoundTitleBodies,
  ...redirectShellBodies,
  ...signupShellBodies,
  ...trackingPixelBodies,
  ...financialRegistryShellBodies,
  ...waybackShellBodies,
  ...archiveRedirectBodies,
  ...emptyHtmlBodies,
  ...articleNotFoundBodies,
  '<html><head><title></title></head><body><div>Powered and protected by</div><div>Privacy</div></body></html>',
  '<html><body><!-- BEGIN WAYBACK TOOLBAR INSERT --><div id="wm-ipp-base">Wayback Machine: April 16, 2026</div><!-- END WAYBACK TOOLBAR INSERT --><div>Powered and protected by</div><div>Privacy</div></body></html>',
  'Powered and protected by\n\nPrivacy',
  'Title:\n\nURL Source: https://example.com/page\n\nMarkdown Content:\nPowered and protected by\n\nPrivacy',
  'Title:\n\nURL Source: https://example.com/page\n\nPublished Time: 2026-04-16\n\nMarkdown Content:\nPowered and protected by\n\nPrivacy',
  ...clinicalTrialShellBodies,
  ...federalRegisterAccessBodies,
  ...loginLockoutBodies,
  ...orgChartControlBodies,
  ...clientBlockedBodies,
];

const financialTables = '<table><tr><th>Metric</th><th>2026</th><th>2025</th></tr>'
  + '<tr><td>Revenue</td><td>$100</td><td>$100</td></tr>'
  + '<tr><td>Costs</td><td>$10</td><td>-$10</td></tr></table>'
  + '<table><tr><th>Metric</th><th>2026</th><th>2025</th></tr>'
  + '<tr><td>Revenue</td><td>€100</td><td>€100</td></tr></table>';

test('text cleaning preserves repeated evidence, table headings, currencies and signs', () => {
  for (const text of [
    htmlToText(financialTables),
    'ARR\n\nRevenue\n\nARR\n\nRevenue',
    'Not audited.\nNot audited.\nNOT AUDITED.',
    '10%\n10\n-10\n10%\n10x\n10x\n0\n0',
  ]) {
    assert.deepEqual(cleanExtractedText(text), { text, removedLines: 0, dedupedLines: 0 });
  }
});

test('text cleaning still removes known boilerplate without removing repeated evidence', () => {
  assert.deepEqual(cleanExtractedText('Accept all cookies\nRevenue\nMenu\nRevenue\nAccept all cookies'), {
    text: 'Revenue\nRevenue', removedLines: 3, dedupedLines: 0,
  });
});

test('fetch CLI preserves financial tables in main, full, cached and reader text', () => {
  const folder = mkdtempSync(join(tmpdir(), 'source-table-check-'));
  const tableText = htmlToText(financialTables);
  const html = '<html><head><title>Annual financial results</title></head><body><main><article>'
    + '<h1>Annual financial results</h1><p>These comparative financial statements report annual revenue and costs '
    + 'for both periods. Each column must retain its own reporting year, currency, amount and sign. '
    + 'The second table reports a different currency, not another copy of the first table.</p>'
    + '<p>The comparative presentation intentionally repeats the reporting years and revenue label. '
    + 'Equal revenue amounts in separate periods are separate observations. A negative cost amount must not '
    + 'be treated as equivalent to a positive cost amount, even when the absolute values are identical.</p>'
    + '<p>The currency symbols distinguish the two statements. Preserving each occurrence keeps the rows '
    + 'aligned with their columns and avoids changing the interpretation of the source financial statements.</p>'
    + financialTables + '</article></main></body></html>';
  const url = 'https://example.com/financials';
  try {
    for (const mode of ['main', 'full', 'cache', 'reader']) {
      const body = mode === 'reader'
        ? `Title: Annual financial results\n\nMarkdown Content:\n\n${tableText}` : html;
      if (mode === 'cache') {
        writeFileSync(join(folder, `${canonicalCacheKey(url)}.json`), JSON.stringify({
          requestedUrl: url, finalUrl: url, status: 200, ok: true,
          contentType: 'text/html', body: Buffer.from(html).toString('base64'),
          source: 'origin', fetchedAt: new Date().toISOString(),
        }));
      }
      const flags = [
        url, '--json', '--no-host-map', '--no-throttle', '--no-retry-profiles', '--no-wayback',
        ...(mode === 'cache' ? ['--cache-dir', folder] : ['--no-cache']),
        ...(mode === 'full' ? ['--full-text'] : []),
        ...(mode === 'reader' ? ['--via-reader'] : ['--no-reader']),
      ];
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import { main } from './.agents/skills/fetch-url/scripts/fetch.mjs';
        let requests = 0;
        globalThis.fetch = async (requestUrl) => {
          requests += 1;
          const response = new Response(${JSON.stringify(body)}, {
            status: 200, headers: { 'content-type': ${JSON.stringify(mode === 'reader' ? 'text/plain' : 'text/html')} },
          });
          Object.defineProperty(response, 'url', { value: String(requestUrl) });
          return response;
        };
        await main(${JSON.stringify(flags)});
        assert.equal(requests, ${mode === 'cache' ? 0 : 1});
      `], { encoding: 'utf8', env: { ...process.env, STARTUP_FETCH_LOG_PATH: '' } });
      assert.equal(result.status, 0, `${mode}: ${result.stderr}`);
      const output = JSON.parse(result.stdout);
      assert.equal(output.ok, true, mode);
      assert.equal(output.output.includes(tableText), true, `${mode}: ${output.output}`);
      assert.equal(output.extraction.cleaning.dedupedLines, 0, mode);
      assert.equal(output.cache.hit, mode === 'cache', mode);
      assert.equal(output.extraction.method, ['main', 'cache'].includes(mode) ? 'readability' : 'full-text', mode);
      assert.equal(output.retrievalSource, mode === 'reader' ? 'reader' : 'origin', mode);
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('fetch CLI excludes hidden login dialogs without discarding the public org chart or raw bytes', () => {
  const folder = mkdtempSync(join(tmpdir(), 'source-hidden-lockout-check-'));
  const url = 'https://example.com/org-chart';
  const body = '<html><head><title>Example Company Org Chart</title></head><body>'
    + '<aside><h1>Example Company Org Chart</h1><div>2 executives</div><div>CEO</div><div>A. Founder</div>'
    + '<div>CFO</div><div>B. Finance</div><div>Updated Aug 20, 2025</div></aside>'
    + '<article><div>Search the org chart</div><p>Please certify that all the modifications are exact</p></article>'
    + '<div id="signin-bubble" class="hidden"><div>For each of our 1,321,081 listed executives,<br>discover their exact roles<br>and their biographies.</div><a>Complimentary Test</a></div>'
    + `<div id="userLoginLimitEffort-bubble" class="hidden"><div>${loginLockoutText.replaceAll('\n', '<br>')}</div><a>Close</a></div>`
    + '</body></html>';
  try {
    for (const mode of ['main', 'full', 'reader', 'archive', 'cache', 'archive-cache', 'raw']) {
      const cached = mode === 'cache' || mode === 'archive-cache';
      const variant = mode === 'archive-cache' ? 'wayback' : 'origin';
      const log = join(folder, `${mode}.jsonl`);
      const rawFile = join(folder, 'original.html');
      if (cached) writeFileSync(join(folder, `${canonicalCacheKey(url, variant)}.json`), JSON.stringify({
        requestedUrl: url, finalUrl: url, status: 200, ok: true, contentType: 'text/html',
        body: Buffer.from(body).toString('base64'), source: variant, fetchedAt: new Date().toISOString(),
      }));
      const flags = [
        url, '--json', '--no-host-map', '--no-throttle', '--no-retry-profiles', '--no-reader', '--no-wayback',
        ...(cached ? ['--cache-dir', folder] : ['--no-cache']),
        ...(mode === 'full' ? ['--full-text'] : []),
        ...(mode === 'reader' ? ['--via-reader'] : []),
        ...(mode === 'archive' || mode === 'archive-cache' ? ['--via-wayback'] : []),
        ...(mode === 'raw' ? ['--raw', '--out', rawFile] : []),
      ];
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import { main } from './.agents/skills/fetch-url/scripts/fetch.mjs';
        let requests = 0;
        globalThis.fetch = async (url) => {
          requests++;
          const response = new Response(${JSON.stringify(body)}, { status: 200, headers: { 'content-type': 'text/html' } });
          Object.defineProperty(response, 'url', { value: String(url) });
          return response;
        };
        await main(${JSON.stringify(flags)});
        assert.equal(requests, ${cached ? 0 : 1});
      `], { encoding: 'utf8', env: { ...process.env, STARTUP_FETCH_LOG_PATH: log } });
      assert.equal(result.status, 0, `${mode}: ${result.stderr}`);
      const output = JSON.parse(result.stdout);
      assert.equal(output.ok, true, mode);
      assert.equal(output.cache.hit, cached, mode);
      const trail = JSON.parse(readFileSync(log, 'utf8').trim());
      assert.equal(trail.ok, true, mode);
      assert.equal(trail.sha256, createHash('sha256').update(body).digest('hex'), mode);
      if (mode === 'raw') {
        assert.deepEqual(readFileSync(rawFile), Buffer.from(body));
      } else {
        for (const text of ['2 executives', 'CEO', 'A. Founder', 'CFO', 'B. Finance', 'Updated Aug 20, 2025']) {
          assert.ok(output.output.includes(text), `${mode}: missing ${text}: ${output.output}`);
        }
        assert.doesNotMatch(output.output, /unsuccessful trials|interrupted for 10 minutes|Complimentary Test/);
        if (mode !== 'full') assert.equal(output.extraction.fallbackReason, 'readability-org-chart-controls');
      }
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('fetch CLI preserves visible articles explaining lockouts in fresh and cached responses', () => {
  const folder = mkdtempSync(join(tmpdir(), 'source-lockout-article-check-'));
  const url = 'https://example.com/security-guide';
  const article = 'This guide explains login lockouts rather than denying access. The example below illustrates a temporary account restriction. Public company records still require independent review.';
  const body = `<html><head><title>Account security guide</title></head><body><section id="signin-bubble" class="not-hidden"><h1>Account security guide</h1>${`<p>${article}</p>`.repeat(4)}<blockquote>${loginLockoutText}</blockquote></section></body></html>`;
  try {
    for (const cached of [false, true]) {
      if (cached) writeFileSync(join(folder, `${canonicalCacheKey(url)}.json`), JSON.stringify({
        requestedUrl: url, finalUrl: url, status: 200, ok: true, contentType: 'text/html',
        body: Buffer.from(body).toString('base64'), source: 'origin', fetchedAt: new Date().toISOString(),
      }));
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import { main } from './.agents/skills/fetch-url/scripts/fetch.mjs';
        let requests = 0;
        globalThis.fetch = async () => {
          requests++;
          return new Response(${JSON.stringify(body)}, { status: 200, headers: { 'content-type': 'text/html' } });
        };
        await main(${JSON.stringify([
          url, '--json', '--no-host-map', '--no-throttle', '--no-retry-profiles', '--no-reader', '--no-wayback',
          ...(cached ? ['--cache-dir', folder] : ['--no-cache']),
        ])});
        assert.equal(requests, ${cached ? 0 : 1});
      `], { encoding: 'utf8', env: { ...process.env, STARTUP_FETCH_LOG_PATH: '' } });
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.ok, true);
      assert.equal(output.cache.hit, cached);
      assert.ok(output.output.includes(article));
      assert.ok(output.output.includes('After three unsuccessful trials'));
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('fetch CLI preserves raw image bytes, metadata and provenance across output modes', () => {
  const folder = mkdtempSync(join(tmpdir(), 'source-binary-check-'));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
  const url = 'https://example.com/chart.png';
  try {
    for (const mode of ['origin-file', 'cache-file', 'json', 'terminal', 'missing-type', 'octet-stream']) {
      const outputPath = join(folder, `${mode}.png`);
      const log = join(folder, `${mode}.jsonl`);
      const contentType = mode === 'missing-type' ? null : mode === 'octet-stream' ? 'application/octet-stream' : 'image/png';
      const fileMode = mode.endsWith('-file');
      if (mode === 'cache-file') {
        writeFileSync(join(folder, `${canonicalCacheKey(url)}.json`), JSON.stringify({
          requestedUrl: url, finalUrl: url, status: 200, ok: true,
          contentType, body: png.toString('base64'), source: 'origin',
          fetchedAt: new Date().toISOString(),
        }));
      }
      const flags = [
        url, '--raw', '--max-chars', '5', '--no-host-map', '--no-throttle',
        '--no-retry-profiles', '--no-reader', '--no-wayback',
        ...(mode === 'cache-file' ? ['--cache-dir', folder] : ['--no-cache']),
        ...(fileMode ? ['--out', outputPath] : []),
        ...(mode === 'terminal' ? [] : ['--json']),
      ];
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import { main } from './.agents/skills/fetch-url/scripts/fetch.mjs';
        let requests = 0;
        globalThis.fetch = async (requestUrl) => {
          requests++;
          const response = new Response(Buffer.from(${JSON.stringify(png.toString('base64'))}, 'base64'), {
            status: 200, headers: ${JSON.stringify(contentType ? { 'content-type': contentType } : {})},
          });
          Object.defineProperty(response, 'url', { value: String(requestUrl) });
          return response;
        };
        await main(${JSON.stringify(flags)});
        assert.equal(requests, ${mode === 'cache-file' ? 0 : 1});
      `], { encoding: 'utf8', env: { ...process.env, STARTUP_FETCH_LOG_PATH: log } });
      assert.equal(result.status, 0, `${mode}: ${result.stderr}`);
      const trail = JSON.parse(readFileSync(log, 'utf8').trim());
      assert.equal(trail.ok, true);
      assert.equal(trail.sha256, createHash('sha256').update(png).digest('hex'));
      assert.equal(trail.bytes, png.length);
      if (mode === 'terminal') {
        assert.match(result.stdout, /binary/i);
        assert.doesNotMatch(result.stdout, /\uFFFD|PNG|base64,/);
        continue;
      }
      const output = JSON.parse(result.stdout);
      assert.equal(output.format, 'binary', mode);
      assert.equal(output.outputKind, 'bytes', mode);
      assert.equal(output.outputBytes, png.length, mode);
      assert.equal(output.truncated, false, mode);
      assert.equal(output.title, null, mode);
      assert.equal(output.output, undefined, mode);
      assert.equal(output.cache.hit, mode === 'cache-file', mode);
      if (fileMode) {
        assert.deepEqual(readFileSync(outputPath), png, mode);
        assert.equal(output.outputFile.kind, 'bytes', mode);
        assert.equal(output.outputFile.bytes, png.length, mode);
        assert.equal(output.outputBase64, undefined, mode);
      } else {
        assert.deepEqual(Buffer.from(output.outputBase64, 'base64'), png, mode);
      }
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('fetch CLI keeps raw PDF and HTML files byte-exact without changing readable output', () => {
  const folder = mkdtempSync(join(tmpdir(), 'source-raw-check-'));
  const toolbar = '<!-- BEGIN WAYBACK TOOLBAR INSERT --><div id="wm-ipp-base">Archive</div><!-- END WAYBACK TOOLBAR INSERT -->';
  try {
    for (const mode of ['pdf', 'svg', 'html', 'archive-html', 'html-json', 'html-text']) {
      const isPdf = mode === 'pdf';
      const raw = mode !== 'html-text';
      const fileMode = !['html-json', 'html-text'].includes(mode);
      const html = mode === 'svg'
        ? '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L1 1"/></svg>'
        : `<html><title>Original</title><body>${toolbar}<p>Original source content.</p></body></html>`;
      const body = Buffer.from(isPdf ? '%PDF-1.7\nOriginal binary \u00ff\n%%EOF' : html);
      const outputPath = join(folder, `${mode}.out`);
      const flags = [
        'https://example.com/source', '--json', '--no-cache', '--no-host-map',
        '--no-throttle', '--no-retry-profiles', '--no-reader', '--no-wayback',
        ...(raw ? ['--raw'] : []),
        ...(fileMode ? ['--out', outputPath, '--max-chars', '5'] : []),
        ...(mode === 'archive-html' ? ['--via-wayback'] : []),
      ];
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import { main } from './.agents/skills/fetch-url/scripts/fetch.mjs';
        globalThis.fetch = async () => new Response(Buffer.from(${JSON.stringify(body.toString('base64'))}, 'base64'), {
          status: 200, headers: { 'content-type': ${JSON.stringify(isPdf ? 'application/pdf' : mode === 'svg' ? 'image/svg+xml' : 'text/html')} },
        });
        await main(${JSON.stringify(flags)});
      `], { encoding: 'utf8', env: { ...process.env, STARTUP_FETCH_LOG_PATH: '' } });
      assert.equal(result.status, 0, `${mode}: ${result.stderr}`);
      const output = JSON.parse(result.stdout);
      assert.equal(output.format, isPdf ? 'pdf' : 'html', mode);
      assert.equal(output.truncated, false, mode);
      if (fileMode) {
        assert.deepEqual(readFileSync(outputPath), body, mode);
        assert.equal(output.outputFile.bytes, body.length, mode);
        assert.equal(output.outputFile.kind, isPdf ? 'pdf' : 'body', mode);
      } else if (raw) {
        assert.equal(output.output, html);
        assert.equal(output.outputKind, 'body');
      } else {
        assert.match(output.output, /Original source content\./);
        assert.doesNotMatch(output.output, /<p>|<html>/);
        assert.equal(output.outputKind, 'text');
      }
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('HTTP-200 challenge pages are not successful source retrievals', () => {
  for (const body of accessErrorBodies) {
    assert.equal(looksLikeBotChallenge({ status: 200, body: Buffer.from(body) }), true, body);
  }
  assert.equal(isAccessErrorResponse({ status: 200, title: '页面未找到', body: '' }), true);
  assert.equal(isAccessErrorResponse({ status: 200, title: '404 | Page Not Found', body: '' }), true);
  assert.equal(isAccessErrorResponse({ status: 200, title: 'DO NOT DELETE - 404 Page', body: '' }), true);
  assert.equal(isAccessErrorResponse({ status: 200, title: 'ClinicalTrials.gov', body: 'Show glossary' }), true);
  assert.equal(isAccessErrorResponse({ status: 200, title: 'Wayback Machine', body: '' }), true);
  assert.equal(isAccessErrorResponse({ status: 200, title: 'Federal Register :: Request Access', body: '' }), true);
});

test('browser client-blocked notices require complete error-shell text', () => {
  for (const body of clientBlockedBodies) {
    assert.equal(isAccessErrorResponse({ status: 200, body }), true, body);
  }
  for (const body of [
    `Browser troubleshooting guide\n\n${clientBlockedText}`,
    `${clientBlockedText}\n\nThis article explains how browser extensions block requests.`,
    'ERR_BLOCKED_BY_CLIENT',
    'example.com is blocked\n\nThis page has been blocked by Chrome',
    'The company reported revenue of $150M. A reader displayed ERR_BLOCKED_BY_CLIENT.',
    `Title: Browser troubleshooting\n\nURL Source: https://example.com/guide\n\nMarkdown Content:\n${clientBlockedText}\n\nThe page above is an example, not a company record.`,
    `<html><head><title>Browser errors</title></head><body><article><p>This guide explains browser error messages.</p><pre>${clientBlockedText}</pre></article></body></html>`,
    Buffer.from(`%PDF-1.7\n${clientBlockedText}`),
  ]) assert.equal(isAccessErrorResponse({ status: 200, body }), false, String(body));
});

test('access-error detection preserves real articles about security and PDF bodies', () => {
  for (const body of [
    '<html><title>DataDome company overview</title><article>DataDome provides captcha and bot detection.</article></html>',
    '<html><title>Understanding Vercel Security Checkpoint</title><article>A technical article about browser challenges.</article></html>',
    'Security troubleshooting guide\n\nA required part of this site couldn’t load is a message that users may encounter.',
    '<html><title>理解页面未找到错误</title><article>404 页面未找到是常见的网站错误。本文介绍如何排查。</article></html>',
    '<html><title>Understanding 404 - Page Not Found</title><article>A guide to error handling.</article></html>',
    '<html><title>Understanding 404 | Page Not Found</title><article>A guide to error handling.</article></html>',
    '<html><title>Understanding DO NOT DELETE - 404 Page</title><article>A guide to error handling.</article></html>',
    `<html><title>Missing articles</title><article><h1>How to diagnose missing articles</h1><p>${articleNotFoundText}</p><h2>${articleNotFoundText}</h2><p>This is an example notice.</p></article></html>`,
    `# How to diagnose missing articles\n\n## ${articleNotFoundText}\n\nThis is an example notice.`,
    `${articleNotFoundText}\n\nThis article explains the notice rather than serving an error page.`,
    `Title: Missing articles\n\nURL Source: https://example.com/guide\n\nMarkdown Content:\n# Error handling\n\n\`\`\`html\n<h1>${articleNotFoundText}</h1>\n\`\`\`\n\nAn example of an error heading.`,
    '<html><title>Understanding Federal Register :: Request Access</title><article>A guide to the public API.</article></html>',
    `Federal Register access guide\n\n${federalRegisterAccessText}`,
    `${federalRegisterAccessText}\n\nThis article quotes an access notice; it does not serve the challenge.`,
    `Account security guide\n\n${loginLockoutText}`,
    `${loginLockoutText}\n\nThis article explains the lockout notice, rather than presenting an access error.`,
    `Title: Example Company Org Chart\n\nURL Source: https://example.com/org-chart\n\nMarkdown Content:\nCEO: A. Founder.\n\n${loginLockoutText}`,
    `<html><head><title>Example Company Org Chart</title></head><body><article>CEO: A. Founder.</article><div class="hidden">${loginLockoutText}</div></body></html>`,
    `${orgChartControlText}\n\nCEO: A. Founder.`,
    `Editing guide\n\n${orgChartControlText}`,
    'The Federal Register revised the rule effective February 12, 2026. Its web page sometimes displays "Request Access".',
    'Title: Funding announcement\n\nURL Source: https://example.com/article\n\nMarkdown Content:\nThe company raised $150M. An old link is titled DO NOT DELETE - 404 Page.',
    'Title: Funding announcement\n\nURL Source: https://example.com/article\n\nMarkdown Content:\nThe company raised $150M. An old link is titled 404 | Page Not Found.',
    '404 documents were processed, while three links returned page not found.',
    '404\n\n没有找到此种页面\n\nThis report analyzes the error rather than serving an error page.',
    'You are now being redirected to shortly.....\n\nThis article explains the redirect message rather than serving a redirect shell.',
    'Revenue rose to $14.7 million in the second quarter. New to Earnings Whispers? Create FREE account to continue.',
    'Title: Earnings Whispers\n\nURL Source: https://example.com/earnings\n\nMarkdown Content:\nRevenue rose to $14.7 million in the second quarter.\n\nCreate FREE account to continue.',
    'A 1x1 image, likely be a tacker probe\n\nThis article explains the reader placeholder rather than serving only a tracking image.',
    '<html><title>Tracking pixels</title><article>A 1x1 image, likely be a tracker probe. This document explains how tracking images work.</article></html>',
    'Title: https://match.adsrvr.org/track/cmf/generic\n\nURL Source: https://example.com/article\n\nWarning: This is a cached snapshot of the original page, consider retry with caching opt-out.\n\nMarkdown Content:\nThe company introduced tax-planning software in February 2026.',
    'Skip to navigation\n\nFirm registration: Example Financial LLC, CRD 123456.',
    'Skip to main content\nSkip to navigation\n\nFirm registration: Example Financial LLC, CRD 123456.',
    '<html><head><title>IAPD - Investment Adviser Public Disclosure - Homepage</title></head><body><a>Skip to navigation</a><article>Firm registration: Example Financial LLC, CRD 123456.</article></body></html>',
    '<html><head><title>BrokerCheck - Find a broker, investment or financial advisor</title></head><body><article>Firm registration: Example Financial LLC, CRD 123456.</article></body></html>',
    'Title: BrokerCheck - Find a broker, investment or financial advisor\n\nURL Source: https://brokercheck.finra.org/firm/summary/123456\n\nMarkdown Content:\nBrokerCheck - Find a broker, investment or financial advisor\n\nFirm registration: Example Financial LLC, CRD 123456.',
    'BrokerCheck - Find a broker, investment or financial advisor\n\nThis article discusses an empty application shell rather than providing one.',
    '<html><title>Funding announcement</title><body><article>The company raised $150M.</article><div>Powered and protected by</div><div>Privacy</div></body></html>',
    '<html><body><!-- BEGIN WAYBACK TOOLBAR INSERT --><div id="wm-ipp-base">Wayback Machine</div><!-- END WAYBACK TOOLBAR INSERT --><article>The company raised $150M.</article><div>Powered and protected by</div><div>Privacy</div></body></html>',
    'Title: Funding announcement\n\nURL Source: https://example.com/page\n\nPublished Time: 2026-04-16\n\nMarkdown Content:\nThe company raised $150M.\nPowered and protected by\n\nPrivacy',
    'Powered and protected by\n\nPrivacy\n\nThis article explains the footer rather than serving a challenge page.',
    `<html><head><title>ClinicalTrials.gov</title></head><body>${clinicalGlossaryShell}<article>Study enrollment: 60 estimated participants.</article></body></html>`,
    'ClinicalTrials.gov\n\nShow glossary\n\nStudy enrollment: 60 estimated participants.',
    'Title: ClinicalTrials.gov\n\nURL Source: https://clinicaltrials.gov/study/NCT00000001\n\nMarkdown Content:\nShow glossary\n\nStudy enrollment: 60 estimated participants.',
    'ClinicalTrials.gov\n\nShow glossary\n\nThis article describes a JavaScript shell rather than serving one.',
    'Show glossary',
    `${waybackBanner}\n\nReported revenue: $288M in 2025, with estimated growth of 5-10% in 2026.`,
    `<html><head><title>Wayback Machine</title></head><body><!-- BEGIN WAYBACK TOOLBAR INSERT --><div id="wm-ipp-print">${waybackBanner}</div><!-- END WAYBACK TOOLBAR INSERT --><article>Reported revenue: $288M in 2025.</article></body></html>`,
    'Title: Wayback Machine\n\nURL Source: https://example.com/financials\n\nMarkdown Content:\nReported revenue: $288M in 2025.',
    'Wayback Machine\n\nThis article explains how archived pages are retrieved.',
    'The archive displayed "Got an HTTP 302 response at crawl time" and "Redirecting to..." instead of the original page.',
    `${archiveRedirectText}\n\nThis article explains the archived redirect above; it is not an interstitial.`,
    `<html><article><h1>Archived redirects</h1><p>This article discusses an error example:</p><pre>${archiveRedirectText}</pre><p>The company reported revenue of $288M in 2025.</p></article></html>`,
    '<html><head><title>Company profile</title></head><body><p>Revenue: $288M in 2025.</p></body></html>',
    'Title: Company profile\n\nURL Source: https://example.com/profile\n\nMarkdown Content:\nRevenue: $288M in 2025.',
    Buffer.from('%PDF-1.7\nTitle: Vercel Security Checkpoint'),
    Buffer.from('%PDF-1.7\nTitle: 页面未找到'),
    Buffer.from('%PDF-1.7\nTitle: 404 | Page Not Found'),
    Buffer.from('%PDF-1.7\nTitle: DO NOT DELETE - 404 Page'),
    Buffer.from(`%PDF-1.7\n# ${articleNotFoundText}`),
    Buffer.from(`%PDF-1.7\nTitle: Federal Register :: Request Access\n${federalRegisterAccessText}`),
    Buffer.from(`%PDF-1.7\n${loginLockoutText}`),
    Buffer.from(`%PDF-1.7\n${orgChartControlText}`),
    Buffer.from('%PDF-1.7\nYou are now being redirected to shortly.....'),
    Buffer.from('%PDF-1.7\nNew to Earnings Whispers?\nCreate FREE account to continue.'),
    Buffer.from('%PDF-1.7\nA 1x1 image, likely be a tacker probe'),
    Buffer.from('%PDF-1.7\nSkip to navigation'),
    Buffer.from('%PDF-1.7\nBrokerCheck - Find a broker, investment or financial advisor'),
    Buffer.from('%PDF-1.7\nPowered and protected by\n\nPrivacy'),
    Buffer.from('%PDF-1.7\nClinicalTrials.gov\n\nShow glossary'),
    Buffer.from(`%PDF-1.7\n${waybackBanner}`),
    Buffer.from(`%PDF-1.7\n${archiveRedirectText}`),
  ]) assert.equal(isAccessErrorResponse({ status: 200, body }), false);
});

test('empty textual responses fail regardless of successful HTTP status, without rejecting raw media', () => {
  for (const status of [200, 202]) {
    for (const contentType of ['text/html', 'text/html; charset=UTF-8', 'application/xhtml+xml', 'text/plain; charset=utf-8']) {
      for (const body of ['', ' \n\t ']) {
        assert.equal(isAccessErrorResponse({ status, contentType, body }), true, `${status}: ${contentType}`);
      }
    }
  }
  for (const [contentType, body] of [
    ['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L1 1"/></svg>'],
    ['application/xml', '<records><record id="1"/></records>'],
    ['application/pdf', Buffer.from('%PDF-1.7\n%%EOF')],
    ['image/png', Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')],
    ['text/plain', '0'],
    ['text/html', '<html><body>0</body></html>'],
  ]) assert.equal(isAccessErrorResponse({ status: 200, contentType, body }), false, contentType);
});

test('fetch CLI records empty HTTP-200 and HTTP-202 text as failed, including old successful caches', () => {
  const folder = mkdtempSync(join(tmpdir(), 'source-empty-text-check-'));
  const url = 'https://example.com/empty';
  try {
    for (const status of [200, 202]) {
      for (const contentType of ['text/html', 'application/xhtml+xml', 'text/plain']) {
        for (const cached of [false, true]) {
          const body = ' \n\t ';
          const log = join(folder, 'fetch.jsonl');
          const requests = join(folder, 'requests.txt');
          rmSync(log, { force: true });
          writeFileSync(requests, '');
          if (cached) writeFileSync(join(folder, `${canonicalCacheKey(url)}.json`), JSON.stringify({
            requestedUrl: url, finalUrl: url, status, ok: true, contentType,
            body: Buffer.from(body).toString('base64'), source: 'origin', fetchedAt: new Date().toISOString(),
          }));
          const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
            import { appendFileSync } from 'node:fs';
            import { main } from './.agents/skills/fetch-url/scripts/fetch.mjs';
            globalThis.fetch = async () => {
              appendFileSync(${JSON.stringify(requests)}, 'request\\n');
              return new Response(${JSON.stringify(body)}, {
                status: ${status}, headers: { 'content-type': ${JSON.stringify(contentType)} },
              });
            };
            await main(${JSON.stringify([
              url, '--json', '--no-host-map', '--no-throttle', '--no-retry-profiles',
              '--no-reader', '--no-wayback', ...(cached ? ['--cache-dir', folder] : ['--no-cache']),
            ])});
          `], { encoding: 'utf8', env: { ...process.env, STARTUP_FETCH_LOG_PATH: log } });
          assert.equal(result.status, 1, result.stderr);
          const output = JSON.parse(result.stdout);
          assert.equal(output.status, status);
          assert.equal(output.ok, false);
          assert.equal(output.cache.hit, false);
          assert.match(output.error, /access-error/);
          assert.equal(output.output, '');
          assert.equal(JSON.parse(readFileSync(log, 'utf8').trim()).ok, false);
          assert.equal(readFileSync(requests, 'utf8'), 'request\n');
          if (cached) assert.match(result.stderr, /cached access-error page is unusable/);
        }
      }
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('reader URLs preserve the original scheme without adding a second one', () => {
  for (const url of ['http://example.com/page', 'https://example.com/page?q=1']) {
    assert.equal(readerUrl(url), `https://r.jina.ai/${url}`);
  }
});

test('fetch CLI rejects origin, reader, archived, and cached access-error pages with a failed fetch trail', () => {
  const folder = mkdtempSync(join(tmpdir(), 'source-fetch-check-'));
  try {
    const bodies = [...accessErrorBodies, signupChromeBody, loginLockoutChromeBody];
    const cases = bodies.flatMap((_, index) =>
      ['origin', 'reader', 'archive', 'cache', 'archive-cache'].map((mode) => [index, mode]));
    for (const [index, mode] of cases) {
      const url = 'https://example.com/page';
      const log = join(folder, `${index}-${mode}.jsonl`);
      const requests = join(folder, `${index}-${mode}-requests.jsonl`);
      const cachedMode = mode === 'cache' || mode === 'archive-cache';
      const cacheSource = mode === 'archive-cache' ? 'wayback' : 'origin';
      if (cachedMode) {
        writeFileSync(join(folder, `${canonicalCacheKey(url, cacheSource)}.json`), JSON.stringify({
          requestedUrl: url, finalUrl: url, status: 200, ok: true,
          body: Buffer.from(bodies[index]).toString('base64'),
          source: cacheSource, fetchedAt: new Date().toISOString(),
        }));
      }
      const flags = [
        url, '--json', '--no-host-map', '--no-throttle', '--no-retry-profiles', '--no-reader', '--no-wayback',
        ...(cachedMode ? ['--cache-dir', folder] : ['--no-cache']),
        ...(mode === 'reader' ? ['--via-reader'] : []),
        ...(mode === 'archive' || mode === 'archive-cache' ? ['--via-wayback'] : []),
      ];
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import { appendFileSync } from 'node:fs';
        import { main } from './.agents/skills/fetch-url/scripts/fetch.mjs';
        globalThis.fetch = async (url) => {
          appendFileSync(${JSON.stringify(requests)}, JSON.stringify(url) + '\\n');
          return new Response(${JSON.stringify(bodies[index])}, {
            status: 200, headers: { 'content-type': 'text/html' },
          });
        };
        await main(${JSON.stringify(flags)});
      `], { encoding: 'utf8', env: { ...process.env, STARTUP_FETCH_LOG_PATH: log } });
      assert.equal(result.status, 1, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.status, 200);
      assert.equal(output.ok, false);
      assert.equal(output.retrievalSource, mode.startsWith('archive') ? 'wayback' : mode === 'reader' ? 'reader' : 'origin');
      assert.match(output.error, /access-error/);
      const trail = JSON.parse(readFileSync(log, 'utf8').trim());
      assert.equal(trail.ok, false);
      assert.match(trail.error, /access-error/);
      assert.equal(readFileSync(requests, 'utf8').trim().split('\n').length, 1);
      if (cachedMode) assert.match(result.stderr, /cached access-error page is unusable/);
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('fetch CLI recovers an access-error page through a valid reader response', () => {
  for (const body of [accessErrorBodies[0], ...clinicalTrialShellBodies, ...federalRegisterAccessBodies, ...loginLockoutBodies, ...orgChartControlBodies, ...clientBlockedBodies, ...notFoundTitleBodies, ...redirectShellBodies, ...signupShellBodies, ...trackingPixelBodies, ...financialRegistryShellBodies, ...waybackShellBodies, ...archiveRedirectBodies, ...emptyHtmlBodies, ...articleNotFoundBodies, signupChromeBody, loginLockoutChromeBody]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { main } from './.agents/skills/fetch-url/scripts/fetch.mjs';
      const requests = [];
      globalThis.fetch = async (url) => {
        requests.push(url);
        return new Response(String(url).startsWith('https://r.jina.ai/')
          ? 'Title: Original article\\n\\nReadable original evidence, not an access-error page.'
          : ${JSON.stringify(body)}, { status: 200 });
      };
      await main(['https://example.com/page', '--json', '--no-cache', '--no-host-map',
        '--no-throttle', '--no-retry-profiles', '--no-wayback']);
      assert.deepEqual(requests, ['https://example.com/page', 'https://r.jina.ai/https://example.com/page']);
    `], { encoding: 'utf8', env: { ...process.env, STARTUP_FETCH_LOG_PATH: '' } });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.retrievalSource, 'reader');
  }
});

test('fetch CLI refreshes blocked reader and archive fallback caches', () => {
  const folder = mkdtempSync(join(tmpdir(), 'source-fallback-cache-check-'));
  const url = 'https://example.com/page';
  try {
    const cases = ['Powered and protected by\n\nPrivacy', clinicalTrialShellBodies[0], ...federalRegisterAccessBodies, ...loginLockoutBodies, ...orgChartControlBodies, ...clientBlockedBodies, ...notFoundTitleBodies, ...redirectShellBodies, ...signupShellBodies, ...trackingPixelBodies, ...financialRegistryShellBodies, ...waybackShellBodies, ...archiveRedirectBodies, ...emptyHtmlBodies, ...articleNotFoundBodies, signupChromeBody, loginLockoutChromeBody]
      .flatMap((body) => ['reader', 'wayback'].map((variant) => [body, variant]));
    for (const [body, variant] of cases) {
      writeFileSync(join(folder, `${canonicalCacheKey(url, variant)}.json`), JSON.stringify({
        requestedUrl: url, finalUrl: url, status: 200, ok: true,
        body: Buffer.from(body).toString('base64'),
        source: variant, fetchedAt: new Date().toISOString(),
      }));
      const flags = [
        url, '--json', '--cache-dir', folder, '--no-host-map', '--no-throttle', '--no-retry-profiles',
        variant === 'reader' ? '--no-wayback' : '--no-reader',
      ];
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import { main } from './.agents/skills/fetch-url/scripts/fetch.mjs';
        const requests = [];
        globalThis.fetch = async (requestUrl) => {
          requests.push(String(requestUrl));
          return new Response(String(requestUrl) === ${JSON.stringify(url)}
            ? 'Access denied'
            : '<html><article>Verified original evidence: revenue was $150M.</article><div>Powered and protected by</div><div>Privacy</div></html>',
            { status: String(requestUrl) === ${JSON.stringify(url)} ? 403 : 200 });
        };
        await main(${JSON.stringify(flags)});
        assert.equal(requests.length, 2);
        assert.equal(requests[0], ${JSON.stringify(url)});
        assert.equal(requests[1].startsWith(${JSON.stringify(variant === 'reader' ? 'https://r.jina.ai/' : 'https://web.archive.org/web/')}), true);
      `], { encoding: 'utf8', env: { ...process.env, STARTUP_FETCH_LOG_PATH: '' } });
      assert.equal(result.status, 0, `${variant}: ${result.stderr}`);
      const output = JSON.parse(result.stdout);
      assert.equal(output.ok, true, variant);
      assert.equal(output.cache.hit, false, variant);
      assert.equal(output.retrievalSource, variant);
      assert.match(output.output, /Verified original evidence: revenue was \$150M/);
      assert.match(result.stderr, /cached access-error page is unusable/);
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('fetch CLI retains substantive articles with signup navigation in fresh and cached responses', () => {
  const folder = mkdtempSync(join(tmpdir(), 'source-signup-article-check-'));
  const url = 'https://example.com/earnings';
  const article = 'The company reported quarterly revenue of $14.7 million. Its report separates revenue, operating expenses and cash balances, and explains the relevant financial period.';
  const body = signupChromeBody.replace(
    '<h5>New to Earnings Whispers?</h5><p>Create <strong>FREE</strong> account to continue.</p>',
    `<h1>Quarterly results</h1>${`<p>${article}</p>`.repeat(6)}<p>Create FREE account to continue.</p>`,
  );
  try {
    for (const cached of [false, true]) {
      if (cached) writeFileSync(join(folder, `${canonicalCacheKey(url)}.json`), JSON.stringify({
        requestedUrl: url, finalUrl: url, status: 200, ok: true, contentType: 'text/html',
        body: Buffer.from(body).toString('base64'), source: 'origin', fetchedAt: new Date().toISOString(),
      }));
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import { main } from './.agents/skills/fetch-url/scripts/fetch.mjs';
        let requests = 0;
        globalThis.fetch = async () => {
          requests++;
          return new Response(${JSON.stringify(body)}, { status: 200, headers: { 'content-type': 'text/html' } });
        };
        await main(${JSON.stringify([
          url, '--json', '--no-host-map', '--no-throttle', '--no-retry-profiles',
          '--no-reader', '--no-wayback', ...(cached ? ['--cache-dir', folder] : ['--no-cache']),
        ])});
        assert.equal(requests, ${cached ? 0 : 1});
      `], { encoding: 'utf8', env: { ...process.env, STARTUP_FETCH_LOG_PATH: '' } });
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.ok, true);
      assert.equal(output.cache.hit, cached);
      assert(output.output.includes(article));
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('chapter fetch provenance requires an explicitly successful retrieval', () => {
  const root = mkdtempSync(join(tmpdir(), 'source-trail-check-'));
  const folder = join(root, '20260925000000-fetch-trail');
  const cases = [
    { name: 'success', records: [{ ok: true, status: 200 }], verified: true },
    { name: 'challenge', records: [{ ok: false, status: 200, error: 'Access-error page' }] },
    { name: 'network', records: [{ ok: false, status: 0, error: 'fetch failed' }] },
    { name: 'forbidden', records: [{ ok: false, status: 403 }] },
    { name: 'missing-ok', records: [{ status: 200 }] },
    { name: 'missing-status', records: [{ ok: true }] },
    { name: 'error-status', records: [{ ok: true, status: 503 }] },
    { name: 'explicit-error', records: [{ ok: true, status: 200, error: 'Unusable content' }] },
    { name: 'string-status', records: [{ ok: true, status: '200' }] },
    { name: 'truthy-ok', records: [{ ok: 'true', status: 200 }] },
    { name: 'unlogged', records: [] },
    { name: 'retry', records: [{ ok: false, status: 403 }, { ok: true, status: 200 }], verified: true },
    { name: 'later-failure', records: [{ ok: true, status: 200 }, { ok: false, status: 0 }], verified: true },
    {
      name: 'redirected', verified: true,
      records: [{ url: 'https://example.com/old-location', finalUrl: 'https://example.com/redirected', ok: true, status: 200 }],
    },
    {
      name: 'failed-redirect',
      records: [{ url: 'https://example.com/blocked-location', finalUrl: 'https://example.com/failed-redirect', ok: false, status: 422 }],
    },
    {
      name: 'canonical', verified: true, sourceUrl: 'https://www.example.com/canonical/?utm_source=fixture#section',
      records: [{ ok: true, status: 200 }],
    },
    {
      name: 'reader', verified: true,
      records: [{ finalUrl: 'https://r.jina.ai/https://example.com/reader', source: 'reader', ok: true, status: 200 }],
    },
  ];
  const sources = cases.map((item, index) => ({
    id: `SO${String(index + 1).padStart(3, '0')}`,
    url: item.sourceUrl ?? `https://example.com/${item.name}`,
    publisher: 'Fixture publisher', title: `Source ${item.name}`,
    date: '2026-09-25', accessDate: '2026-09-25', accessStatus: 'ok',
    sourceType: 'official', reputationTier: 'high', independence: 'company',
    stance: 'confirming', topics: ['fixture'],
  }));
  const trailPath = join(folder, 'fetch.jsonl');
  const trail = cases.flatMap((item) => item.records.map((record) => ({
    url: `https://example.com/${item.name}`, ...record,
  })));
  try {
    mkdirSync(folder);
    writeFileSync(trailPath, ['{malformed', 'null', '', ...trail.map((entry) => JSON.stringify(entry))].join('\n'));
    writeFileSync(join(folder, '01-company-overview.yaml'), yaml.dump({
      schemaVersion: 'report-v2', artifact: 'company-overview',
      slug: basename(folder).slice(15), runDate: '2026-09-25',
      company: { name: 'Fetch trail fixture' },
      chapter: { number: 1, title: 'Company Overview', summary: 'Isolated source-provenance fixture.' },
      sections: [], tables: [], figures: [],
      localEvidence: { sources, claims: [], searchQueries: [], researchQuestions: [], gaps: [] },
    }));
    const result = spawnSync(process.execPath, [
      '.agents/skills/startup-research/scripts/check-chapter.mjs',
      folder, '01-company-overview.yaml', '--format', 'json',
    ], { encoding: 'utf8', env: { ...process.env, STARTUP_FETCH_LOG_PATH: trailPath } });
    assert.equal(result.status, 1, result.stderr); // The small fixture intentionally misses content floors.
    assert.ok(result.stdout.trim(), result.stderr);
    const output = JSON.parse(result.stdout);
    const unverified = output.warnings.filter((issue) => issue.code === 'unverifiedSource');
    assert.deepEqual(unverified.map((issue) => issue.id),
      sources.filter((_, index) => !cases[index].verified).map((source) => source.id));
    assert.ok(unverified.every((issue) => issue.message.includes('successful')));
    assert.ok(unverified.every((issue) => issue.fix.includes('successful')));
    assert.equal(output.warnings.some((issue) => issue.code === 'fetchTrailMissing'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('source quotes allow typography, whitespace, and ordered omissions', () => {
  const source = 'The company’s ARR is $10M — not audited.\nThe estimate excludes debt.';
  for (const quote of [
    "The company's ARR is $10M - not audited.",
    "The company's ARR … not audited.",
    'ARR is $10M ... The estimate excludes debt.',
  ]) assert.equal(isVerbatimSourceQuote(quote, source), true, quote);
});

test('source quotes allow spacing around word-delimited dashes without editing either input', () => {
  const separators = ['-', '–', '—'].flatMap(dash => [
    dash, ` ${dash} `, `${dash} `, ` ${dash}`, `\t${dash}\n`, `\u00a0${dash}\u2009`,
  ]);
  for (const sourceSeparator of separators) {
    const source = `RedotPay has grown to 5 million verified users${sourceSeparator}expanding rapidly across markets.`;
    for (const quoteSeparator of separators) {
      const quote = `RedotPay has grown to 5 million verified users${quoteSeparator}expanding rapidly across markets.`;
      assert.equal(isVerbatimSourceQuote(quote, source), true, JSON.stringify({ quote, source }));
    }
  }
  assert.equal(isVerbatimSourceQuote('verified users … across markets.', 'verified users—expanding rapidly across markets.'), true);
});

test('word-delimited dash spacing does not erase numbers, signs, ranges, words or punctuation', () => {
  for (const [quote, source] of [
    ['50 million verified users — expanding rapidly.', '5 million verified users—expanding rapidly.'],
    ['5 billion verified users — expanding rapidly.', '5 million verified users—expanding rapidly.'],
    ['5 million verified users — expanding rapidly.', '15 million verified users—expanding rapidly.'],
    ['5 million verified users — expanding rapidly.', '1.5 million verified users—expanding rapidly.'],
    ['500 million verified users — expanding rapidly.', '1,500 million verified users—expanding rapidly.'],
    ['5M in revenue — excluding debt.', '$5M in revenue—excluding debt.'],
    ['$5M in revenue — excluding debt.', '-$5M in revenue—excluding debt.'],
    ['5% growth in revenue — excluding debt.', '-5% growth in revenue—excluding debt.'],
    ['5% growth in revenue — excluding debt.', '+5% growth in revenue—excluding debt.'],
    ['25% growth in revenue — excluding debt.', '2.5% growth in revenue—excluding debt.'],
    ['2024 verified users — expanding rapidly.', '2023 verified users—expanding rapidly.'],
    ['$5M-$11M in revenue — excluding debt.', '$5M-$10M in revenue—excluding debt.'],
    ['18 months in service — still active.', '12–18 months in service—still active.'],
    ['Verified users expanding rapidly.', 'Verified users—expanding rapidly.'],
    ['Verified usersexpanding rapidly.', 'Verified users—expanding rapidly.'],
    ['Verified users--expanding rapidly.', 'Verified users—expanding rapidly.'],
    ['Verified users — expanding rapidly.', 'Verified users—not expanding rapidly.'],
    ['rapidly expanding … verified users', 'verified users—expanding rapidly'],
    ['verified users — expanding rapidly.', 'unverified users—expanding rapidly.'],
    ['Profit -25%', 'Profit — 25%'],
    ['Loss - 25%', 'Loss -25%'],
    ['$5M-$10M', '$5M - $10M'],
    ['12-18 months', '12 – 18 months'],
    ['GPT-6', 'GPT - 6'],
  ]) assert.equal(isVerbatimSourceQuote(quote, source), false, JSON.stringify({ quote, source }));
});

test('word-delimited dash spacing retains partial excerpts and ordered omissions beside dashes', () => {
  const source = 'Verified users — expanding rapidly across markets.';
  for (const quote of [
    'Verified users —',
    '— expanding rapidly',
    'Verified users — … across markets.',
    'users ... — expanding',
    '— expanding ... markets.',
  ]) assert.equal(isVerbatimSourceQuote(quote, source), true, quote);
});

test('prefetched quotation gates accept word-dash spacing but retain evidence and value checks', () => {
  const folder = mkdtempSync(join(tmpdir(), 'source-quote-dash-'));
  const outputFile = join(folder, 'source.txt');
  const url = 'https://example.com/customer-story';
  const source = { id: 'SU008', url, keyQuote: '5 million verified users — expanding rapidly.' };
  try {
    writeFileSync(outputFile, '5 million verified users—expanding rapidly.');
    for (const file of ['06-customers.yaml', 'evidence.yaml']) {
      assert.deepEqual(checkPrefetchedSourceQuotes([source], [{ url, ok: true, outputFile }], file), []);
      assert.equal(checkPrefetchedSourceQuotes(
        [{ ...source, keyQuote: '50 million verified users — expanding rapidly.' }],
        [{ url, ok: true, outputFile }], file,
      )[0].code, 'sourceQuoteMismatch');
      assert.equal(checkPrefetchedSourceQuotes([source], [{ url, ok: false, outputFile }], file)[0].code, 'sourceQuoteTextMissing');
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('source quotes reject fabricated wording, reordered excerpts, and partial numbers', () => {
  for (const [quote, source] of [
    ['ARR is $11M.', 'ARR is $10M.'],
    ['ARR is audited.', 'ARR is not audited.'],
    ['The estimate excludes debt. ... ARR is $10M.', 'ARR is $10M. The estimate excludes debt.'],
    ['Revenue is $10', 'Revenue is $100M.'],
    ['Revenue is $1', 'Revenue is $1,000.'],
    ['Growth is 10', 'Growth is 10%.'],
    ['5M', '10.5M'],
    ['000', '1,000'],
    ['10M', '-10M'],
    ['10M', '$10M'],
    ['$10M', '-$10M'],
    ['Revenue is 102M.', 'Revenue is 10²M.'],
    ['2026', '12026'],
    ['...', 'A complete source.'],
  ]) assert.equal(isVerbatimSourceQuote(quote, source), false, quote);
});

test('chapter source quotas cannot be padded with duplicate URL aliases', () => {
  const sources = [
    { id: 'SV008', url: 'https://example.com/source' },
    { id: 'SV009', url: 'https://www.example.com/source/?utm_source=test#section' },
  ];
  const issues = checkDistinctChapterSources(sources, '08-valuation.yaml');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'duplicateSourceUrl');
  assert.match(issues[0].message, /SV008 and SV009/);
  assert.deepEqual(checkDistinctChapterSources([sources[0], { ...sources[1], url: 'https://example.com/other' }], '08-valuation.yaml'), []);
});

test('prefetched quotation checks require readable successful source text', () => {
  const folder = mkdtempSync(join(tmpdir(), 'source-quote-check-'));
  const outputFile = join(folder, 'source.txt');
  const url = 'https://example.com/source';
  const source = { id: 'SO001', url, keyQuote: 'ARR is $10M.' };
  try {
    writeFileSync(outputFile, source.keyQuote);
    assert.deepEqual(checkPrefetchedSourceQuotes([source], [{ url, ok: true, outputFile }], '01-company-overview.yaml'), []);
    for (const fetched of [[], [{ url, ok: false, outputFile }], [{ url, ok: true }]]) {
      assert.equal(checkPrefetchedSourceQuotes([source], fetched, '01-company-overview.yaml')[0].code, 'sourceQuoteTextMissing');
    }
    assert.equal(checkPrefetchedSourceQuotes(
      [{ ...source, keyQuote: 'ARR is $11M.' }],
      [{ url, ok: true, outputFile }],
      '01-company-overview.yaml',
    )[0].code, 'sourceQuoteMismatch');
    assert.deepEqual(checkPrefetchedSourceQuotes(
      [{ id: 'SO002', url, keyQuote: null }],
      [{ url, ok: true, outputFile }],
      '01-company-overview.yaml',
    ), []);
    const duplicate = { ...source, id: 'SO003', url: `${url}?utm_source=test` };
    const fetched = [{ url, ok: true, outputFile }];
    assert.deepEqual(checkPrefetchedSourceQuotes([source, duplicate], fetched, '01-company-overview.yaml')
      .map((issue) => issue.code), ['duplicateSourceUrl']);
    assert.deepEqual(checkPrefetchedSourceQuotes([source, { ...duplicate, id: 'SM001' }], fetched, 'evidence.yaml'), []);
    for (const body of accessErrorBodies) {
      writeFileSync(outputFile, body);
      for (const keyQuote of [body, null]) {
        for (const file of ['01-company-overview.yaml', 'evidence.yaml']) {
          assert.deepEqual(checkPrefetchedSourceQuotes(
            [{ ...source, keyQuote }],
            [{ url, ok: true, outputFile }],
            file,
          ).map((issue) => issue.code), ['sourceContentBlocked']);
        }
      }
    }
    rmSync(outputFile);
    assert.equal(checkPrefetchedSourceQuotes([source], [{ url, ok: true, outputFile }], '01-company-overview.yaml')[0].code, 'sourceQuoteTextMissing');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

for (const field of ['items', 'nodes']) {
  const check = (touchpoints) => checkFigureDeep({
    id: 'FU001',
    type: 'journey-map',
    data: { [field]: [{ label: 'Expansion', touchpoints }] },
  }, { path: 'fixture.yaml' }).errors;

  test(`journey-map ${field} accepts text without coercing it`, () => {
    for (const touchpoints of [
      undefined,
      [],
      'Partner referral, technical evaluation, production deployment',
      yaml.load('- "JetBlue: 1 -> 10 airports -> all operations"'),
      yaml.load('- >-\n  Nigeria NiMet: agriculture DCAS -> oil and gas'),
      ['从一个枢纽扩展至全网络（JetBlue：1 → 10 个机场 → 全部运营）'],
    ]) {
      assert.deepEqual(check(touchpoints), []);
    }
  });

  test(`journey-map ${field} rejects malformed touchpoint lists`, () => {
    for (const touchpoints of [
      yaml.load('- Expansion from one hub (JetBlue: 1 -> 10 airports)'),
      yaml.load('- Nigeria NiMet: agriculture DCAS -> oil and gas'),
      yaml.load('- Nigeria NiMet:'),
      ['Valid text', null],
      [42],
      [true],
      [['Nested text']],
      42,
      true,
      { label: 'Not a list' },
      null,
    ]) {
      assert(check(touchpoints).some((error) => error.message.includes(
        `data.${field}[0].touchpoints must be text or an array of strings`,
      )), JSON.stringify(touchpoints));
    }
  });
}
