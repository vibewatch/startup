export const FIGURE_TYPES = [
  'timeline',
  'flow',
  'quadrant',
  'bar',
  'waterfall',
  'matrix',
  'stack',
  'pyramid',
  'journey-map',
  'funnel',
  'cohort',
  'range',
  'kpi',
  'dag',
  'other',
];

export const FIGURE_DATA_FIELDS = ['items', 'nodes', 'edges', 'points', 'columns', 'rows', 'series', 'layers', 'xAxis', 'yAxis'];

export const FIGURE_ARRAY_FIELDS = ['items', 'nodes', 'edges', 'points', 'columns', 'rows', 'series', 'layers'];

export const FIGURE_CONTRACTS = {
  timeline: [['items']],
  flow: [['nodes']],
  dag: [['nodes'], ['edges']],
  quadrant: [['points']],
  bar: [['items', 'series']],
  funnel: [['items', 'series']],
  waterfall: [['items']],
  range: [['items']],
  matrix: [['columns'], ['rows']],
  cohort: [['columns'], ['rows']],
  stack: [['layers', 'items']],
  pyramid: [['nodes', 'items']],
  'journey-map': [['nodes', 'items']],
  kpi: [['items', 'nodes']],
};

export const FIGURE_ALLOWED_POPULATED_FIELDS = {
  timeline: ['items'],
  flow: ['nodes', 'edges'],
  dag: ['nodes', 'edges'],
  quadrant: ['points'],
  bar: ['items', 'series'],
  funnel: ['items', 'series'],
  waterfall: ['items'],
  range: ['items'],
  matrix: ['columns', 'rows'],
  cohort: ['columns', 'rows'],
  stack: ['layers', 'items'],
  pyramid: ['nodes', 'items'],
  'journey-map': ['nodes', 'items'],
  kpi: ['items', 'nodes'],
  other: [],
};

export const RENDERED_FIGURE_TYPES = FIGURE_TYPES.filter((type) => type !== 'other');

const FIGURE_TYPE_SET = new Set(FIGURE_TYPES);
const FIGURE_DATA_FIELD_SET = new Set(FIGURE_DATA_FIELDS);

function hasPopulatedField(data, key) {
  const value = data?.[key];
  if (Array.isArray(value)) return value.length > 0;
  return value != null && value !== '';
}

// Lightweight figure shape validator shared between check-chapter.mjs
// (chapter-time) and check-report.mjs (post-finalize). Returns
// { errors: string[] } where each error is a short human-readable reason.
// Renderer-specific deep checks (numeric cohort cells, matrix column/row
// width, etc.) stay in check-report.mjs.
export function validateFigureShape(figure) {
  const errors = [];
  const id = figure?.id ?? '?';
  if (!figure || typeof figure !== 'object') {
    return { errors: [`figure ${id} is not an object`] };
  }
  if (!figure.type || !FIGURE_TYPE_SET.has(figure.type)) {
    errors.push(`figure ${id} has invalid type "${figure.type ?? ''}" (allowed: ${FIGURE_TYPES.join(', ')})`);
    return { errors };
  }
  if (!figure.data || typeof figure.data !== 'object' || Array.isArray(figure.data)) {
    errors.push(`figure ${id} (${figure.type}) requires a structured data object`);
    return { errors };
  }
  for (const field of Object.keys(figure.data)) {
    if (!FIGURE_DATA_FIELD_SET.has(field)) {
      errors.push(`figure ${id} (${figure.type}) uses unsupported data.${field}`);
    }
    if (FIGURE_ARRAY_FIELDS.includes(field) && Array.isArray(figure.data[field]) && figure.data[field].length === 0) {
      errors.push(`figure ${id} (${figure.type}) has empty data.${field}; omit unused arrays`);
    }
  }
  const contract = FIGURE_CONTRACTS[figure.type] ?? [];
  for (const alternatives of contract) {
    const populated = alternatives.filter((key) => hasPopulatedField(figure.data, key));
    if (populated.length === 0) {
      errors.push(`figure ${id} (${figure.type}) requires data.${alternatives.join(' or data.')}`);
    } else if (populated.length > 1) {
      errors.push(`figure ${id} (${figure.type}) must use exactly one of data.${alternatives.join(' or data.')} (found ${populated.map((k) => `data.${k}`).join(' and ')})`);
    }
  }
  const allowed = new Set(FIGURE_ALLOWED_POPULATED_FIELDS[figure.type] ?? []);
  for (const field of FIGURE_ARRAY_FIELDS) {
    if (hasPopulatedField(figure.data, field) && !allowed.has(field)) {
      errors.push(`figure ${id} (${figure.type}) must not populate data.${field}`);
    }
  }
  return { errors };
}
