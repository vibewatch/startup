// Field whitelist for the en→zh translation pipeline.
//
// Each entry maps an artifact (full-report | summary-card)
// to a list of "leaf paths". A leaf path is a slash-separated sequence with
// `[]` markers for arrays. The walker visits matching leaves and only those
// leaves get translated. Everything else is passed through verbatim — ids,
// refs, urls, dates, numerics, and non-final report artifacts stay in English.
//
// Shared with bundle-translatable.mjs / apply-translation.mjs / check-translation.mjs.

// Translatable leaf strings live at these paths. Anything not listed is
// preserved as-is in the .zh.yaml mirror.
//
// Convention: `field` matches scalar at that key; `field/[]` iterates an
// array of scalars; `field/[]/sub` walks each item.sub. Multiple list
// elements (rows of a table, items of a list block) are addressed by
// numeric index when emitted as `path[i]`.

// Figure leaves are reader-visible chart text — titles, captions, axis
// labels, and every label/detail/note inside `figure.data.*`. The renderer
// (website/src/components/FigureRenderer.astro) reads everything from
// `figure.data.{items,nodes,edges,points,columns,rows,series,layers,xAxis,yAxis}`,
// not from top-level keys, so the `data/` prefix is mandatory.
//
// Identifier-shaped keys (`id`, `key`, `slug`, `type`, `kind`, `tone`,
// `status`, `sentiment`, `direction`, `trend`, `confidence`, `group`,
// `stage`, `phase`, `category`, `segment`, `risk`, `unit`, `value`,
// `displayValue`, `date`, `delta`, `from`, `to`, `source`, `target`,
// `claimRefs[]`, `sourceRefs[]`, `captionSources[]`, `xAxis/high|low`,
// `yAxis/high|low`) are intentionally excluded — they drive CSS classes,
// chart geometry, or refer to other artifacts and must stay verbatim. The
// explicit `phase` / `stage` / `risk` / `segment` paths below are exceptions
// for figure shapes where those fields are rendered as reader-visible labels.
const FIGURE_PATHS = [
  // Top-level prose
  'figures/[]/title',
  'figures/[]/subtitle',
  'figures/[]/summary',
  'figures/[]/description',
  'figures/[]/caption',
  'figures/[]/insight',
  'figures/[]/basis',
  'figures/[]/notes',
  'figures/[]/approximationNotes',
  // Top-level axis labels (older / alternative shapes)
  'figures/[]/xAxisLabel',
  'figures/[]/yAxisLabel',
  'figures/[]/xLabel',
  'figures/[]/yLabel',
  'figures/[]/xAxis',
  'figures/[]/yAxis',
  'figures/[]/xAxis/label',
  'figures/[]/yAxis/label',
  // data.xAxis / data.yAxis labels (canonical shape: string OR object with
  // `label`, plus quadrant endpoint labels `high` / `low`)
  'figures/[]/data/xAxis',
  'figures/[]/data/yAxis',
  'figures/[]/data/xAxis/label',
  'figures/[]/data/yAxis/label',
  'figures/[]/data/xAxis/high',
  'figures/[]/data/xAxis/low',
  'figures/[]/data/yAxis/high',
  'figures/[]/data/yAxis/low',
  // data.columns: scalar header OR { label, detail, note }
  'figures/[]/data/columns/[]',
  'figures/[]/data/columns/[]/label',
  'figures/[]/data/columns/[]/detail',
  'figures/[]/data/columns/[]/note',
  // data.rows / data.rows[].values (matrix, cohort, heatmap)
  'figures/[]/data/rows/[]/label',
  'figures/[]/data/rows/[]/note',
  'figures/[]/data/rows/[]/values/[]',
  'figures/[]/data/rows/[]/values/[]/label',
  'figures/[]/data/rows/[]/values/[]/detail',
  'figures/[]/data/rows/[]/values/[]/note',
  'figures/[]/data/rows/[]/values/[]/text',
  // data.items (timeline, range, bar, kpi, journey-map, ...)
  'figures/[]/data/items/[]/label',
  'figures/[]/data/items/[]/detail',
  'figures/[]/data/items/[]/details',
  'figures/[]/data/items/[]/description',
  'figures/[]/data/items/[]/note',
  'figures/[]/data/items/[]/notes',
  'figures/[]/data/items/[]/lowLabel',
  'figures/[]/data/items/[]/highLabel',
  'figures/[]/data/items/[]/examples',
  'figures/[]/data/items/[]/context',
  'figures/[]/data/items/[]/valueNote',
  // journey-map / persona-style row labels (visible header text)
  'figures/[]/data/items/[]/actor',
  'figures/[]/data/items/[]/actors/[]',
  'figures/[]/data/items/[]/phase',
  'figures/[]/data/items/[]/stage',
  'figures/[]/data/items/[]/emotion',
  'figures/[]/data/items/[]/channel',
  'figures/[]/data/items/[]/channels/[]',
  'figures/[]/data/items/[]/touchpoints/[]',
  // data.nodes (flow, dag, pyramid)
  'figures/[]/data/nodes/[]/label',
  'figures/[]/data/nodes/[]/detail',
  'figures/[]/data/nodes/[]/details',
  'figures/[]/data/nodes/[]/description',
  'figures/[]/data/nodes/[]/note',
  'figures/[]/data/nodes/[]/notes',
  'figures/[]/data/nodes/[]/risk',
  'figures/[]/data/nodes/[]/segment',
  // data.edges (flow, dag)
  'figures/[]/data/edges/[]/label',
  'figures/[]/data/edges/[]/detail',
  'figures/[]/data/edges/[]/relationship',
  // data.points (quadrant)
  'figures/[]/data/points/[]/label',
  'figures/[]/data/points/[]/detail',
  'figures/[]/data/points/[]/description',
  'figures/[]/data/points/[]/note',
  // data.layers (stack)
  'figures/[]/data/layers/[]/label',
  'figures/[]/data/layers/[]/detail',
  'figures/[]/data/layers/[]/description',
  'figures/[]/data/layers/[]/items/[]',
  'figures/[]/data/layers/[]/items/[]/label',
  'figures/[]/data/layers/[]/items/[]/detail',
  'figures/[]/data/layers/[]/items/[]/description',
  'figures/[]/data/layers/[]/modules/[]',
  'figures/[]/data/layers/[]/modules/[]/label',
  'figures/[]/data/layers/[]/modules/[]/name',
  'figures/[]/data/layers/[]/modules/[]/detail',
  'figures/[]/data/layers/[]/modules/[]/notes',
  'figures/[]/data/layers/[]/outputs/[]',
  // data.series (bar, funnel)
  'figures/[]/data/series/[]/label',
  'figures/[]/data/series/[]/name',
  'figures/[]/data/series/[]/points/[]/label',
  'figures/[]/data/series/[]/points/[]/detail',
  'figures/[]/data/series/[]/points/[]/details',
  'figures/[]/data/series/[]/points/[]/description',
  'figures/[]/data/series/[]/points/[]/note',
  'figures/[]/data/series/[]/points/[]/notes',
  'figures/[]/data/series/[]/points/[]/context',
  'figures/[]/data/series/[]/points/[]/valueNote',
];

export const TRANSLATE_PATHS = Object.freeze({
  fullReport: [
    'subtitle',
    'coverageNotes',
    'coverFacts/[]/label',
    'companyProfile/summary',
    'companyProfile/productSummary',
    'companyProfile/customerFocus',
    'companyProfile/businessModel',
    'companyProfile/fundingStatus',
    'companyProfile/founders/[]/role',
    'companyProfile/founders/[]/background',
    'chapters/[]/title',
    'chapters/[]/sections/[]/title',
    'chapters/[]/sections/[]/blocks/[]/title',
    'chapters/[]/sections/[]/blocks/[]/body',
    'chapters/[]/sections/[]/blocks/[]/items/[]',
    'tables/[]/title',
    'tables/[]/columns/[]',
    'tables/[]/rows/[]/[]',
    'tables/[]/notes',
    ...FIGURE_PATHS,
    'appendices/[]/title',
    'appendices/[]/blocks/[]/title',
    'appendices/[]/blocks/[]/body',
    'appendices/[]/blocks/[]/items/[]',
    'disclaimer',
  ],
  summaryCard: [
    'summary/headline',
    'summary/topStrengths/[]',
    'summary/topRisks/[]',
    'summary/unresolvedGaps/[]',
  ],
});

// The whitelist alone is the affirmative gate: only paths matched here are
// translated. The validator separately confirms that every English ID/ref
// was preserved verbatim in the .zh.yaml mirror, so no per-key blocklist
// is needed.

// Resolve which whitelist applies to a parsed YAML doc.
export function whitelistFor(doc) {
  const artifact = doc?.artifact;
  if (artifact === 'full-report') return TRANSLATE_PATHS.fullReport;
  if (artifact === 'summary-card') return TRANSLATE_PATHS.summaryCard;
  return [];
}

// Match a path-segment list against a whitelist pattern. `path` is the
// concrete stack ("sections", 0, "body"); `pattern` is the schema
// ("sections", "[]", "body").
export function matchesPattern(path, pattern) {
  const parts = pattern.split('/');
  if (parts.length !== path.length) return false;
  for (let i = 0; i < parts.length; i += 1) {
    const want = parts[i];
    const got = path[i];
    if (want === '[]') {
      if (typeof got !== 'number') return false;
    } else if (want !== String(got)) {
      return false;
    }
  }
  return true;
}

export function isTranslatableLeaf(path, whitelist) {
  return whitelist.some((pattern) => matchesPattern(path, pattern));
}
