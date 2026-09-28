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

export function matrixCellText(cell) {
  const value = cell && typeof cell === 'object'
    ? cell.label ?? cell.text ?? cell.name ?? cell.displayValue ?? cell.value ?? cell.score
    : cell;
  return value == null ? '' : String(value);
}

export const figureDetail = (item) => item.detail ?? item.description;

export function figureValueNotes(item) {
  return [...new Set([
    figureDetail(item) ?? item.summary, ...figureItemNotes(item), item.unit,
  ].filter((value) => typeof value === 'string' && value.trim()))];
}

export function figureItemNotes(item) {
  return [...new Set([
    figureDetail(item), item.description, item.details, item.note, item.notes, item.context, item.valueNote,
  ].filter((value) => typeof value === 'string' && value.trim()))];
}

export function stackLayerDetails(data) {
  const content = (value) => {
    if (value == null) return [];
    if (typeof value !== 'object') return String(value).trim() ? [String(value)] : [];
    return [...new Set([
      value.label ?? value.name ?? value.displayValue ?? value.value ?? value.score ?? value.id,
      value.displayValue ?? value.value ?? value.score,
      ...figureValueNotes(value),
    ].filter((item) => ['string', 'number', 'boolean'].includes(typeof item) && String(item).trim()).map(String))];
  };
  const layers = data?.layers ?? data?.items ?? data?.nodes;
  return (Array.isArray(layers) ? layers : []).map((value, index) => {
    const item = value && typeof value === 'object' ? value : { label: value };
    const label = String(item.label ?? item.name ?? item.id ?? `#${index + 1}`);
    return {
      item,
      label,
      notes: content(item).filter((text) => text !== label),
      groups: ['items', 'modules', 'outputs'].map((key) => ({
        key,
        entries: Array.isArray(item[key]) ? item[key].map(content).filter((lines) => lines.length) : [],
      })).filter((group) => group.entries.length),
    };
  });
}

export function figureUnitsDiffer(items) {
  const units = items.map((item) => item.unit)
    .filter((unit) => typeof unit === 'string' && unit.trim())
    .map((unit) => unit.trim());
  return new Set(units).size > 1;
}

export function barSeries(data) {
  if (Array.isArray(data?.items) && data.items.length) return [{ points: data.items }];
  return Array.isArray(data?.series)
    ? data.series.filter((series) => Array.isArray(series?.points) && series.points.length)
    : [];
}

export function barSeriesTable(series, { valueLabel, contextLabel }) {
  const rows = series.flatMap((group, groupIndex) => group.points.map((point, pointIndex) => {
    const context = [...new Set([point.unit ?? group.unit, ...figureItemNotes(point)]
      .filter((value) => typeof value === 'string' && value.trim()))].join('\n');
    return {
      label: `${group.label || group.name || `#${groupIndex + 1}`} / ${point.label ?? point.name ?? `#${pointIndex + 1}`}`,
      values: [{
        label: String(point.displayValue ?? point.value ?? '\u2014'),
        value: point.value,
        detail: context,
        ...(point.tone ? { tone: point.tone } : {}),
      }, context || null],
    };
  }));
  const hasContext = rows.some((row) => row.values[1]);
  return {
    columns: hasContext ? [valueLabel, contextLabel] : [valueLabel],
    rows: hasContext ? rows : rows.map((row) => ({ ...row, values: row.values.slice(0, 1) })),
  };
}

export function funnelStageTable(data, labels) {
  const series = barSeries(data);
  const table = barSeriesTable(series, labels);
  if (series.length === 1 && !series[0].label && !series[0].name) {
    table.rows.forEach((row, index) => {
      const point = series[0].points[index];
      row.label = point.label ?? point.name ?? `#${index + 1}`;
    });
  }
  return table;
}

export function flowTopology(data) {
  const nodes = Array.isArray(data?.nodes) ? data.nodes : [];
  const edges = Array.isArray(data?.edges) ? data.edges : [];
  const resolve = (endpoint) => {
    if (endpoint == null || endpoint === '') return null;
    const matches = nodes.map((node, index) => {
      const key = node.id ?? node.label ?? String(index + 1);
      return endpoint === key || endpoint === node.id || endpoint === node.label ? index : -1;
    }).filter((index) => index >= 0);
    return matches.length === 1 ? matches[0] : null;
  };
  const endpoints = edges.map((edge) => ({
    fromIndex: resolve(edge.from ?? edge.source),
    toIndex: resolve(edge.to ?? edge.target),
  }));
  const unresolved = endpoints.some(({ fromIndex, toIndex }) => fromIndex == null || toIndex == null);
  const sequence = edges.length === 0 || (!unresolved && edges.length === nodes.length - 1
    && new Set(endpoints.map(({ fromIndex }) => fromIndex)).size === edges.length
    && endpoints.every(({ fromIndex, toIndex }) => toIndex === fromIndex + 1));
  return { sequence, unresolved, endpoints };
}

export function withFlowTopology(figure) {
  return figure.type === 'flow' ? { ...figure, _flowTopology: flowTopology(figure.data) } : figure;
}

export function flowRelationshipTable(data, topology, { nodeLabel, connectionLabel, sourceLabel, targetLabel, contextLabel }) {
  const nodes = Array.isArray(data?.nodes) ? data.nodes : [];
  const edges = Array.isArray(data?.edges) ? data.edges : [];
  const text = (value) => value == null ? '\u2014'
    : typeof value === 'object' ? JSON.stringify(value) : String(value);
  const label = (node, index) => {
    const name = text(node.label ?? node.name ?? node.id ?? `#${index + 1}`);
    return node.id != null && text(node.id) !== name ? `${name} [${text(node.id)}]` : name;
  };
  const context = (item) => [...new Set([
    item.displayValue ?? item.value, item.unit, ...figureValueNotes(item),
  ].filter((value) => value != null && value !== '').map(text))].join('\n');
  const endpoint = (value, index) => index == null ? text(value) : label(nodes[index], index);
  return {
    columns: [sourceLabel, targetLabel, contextLabel],
    rows: [
      ...nodes.map((node, index) => ({
        label: `${nodeLabel} ${index + 1}`,
        values: [{ label: label(node, index), ...(node.tone ? { tone: node.tone } : {}) }, null, context(node) || null],
      })),
      ...edges.map((edge, index) => ({
        label: `${connectionLabel} ${index + 1}`,
        values: [
          endpoint(edge.from ?? edge.source, topology.endpoints[index].fromIndex),
          endpoint(edge.to ?? edge.target, topology.endpoints[index].toIndex),
          [...new Set([edge.label, edge.relationship, context(edge)].filter((value) => value != null && value !== '').map(text))].join('\n') || null,
        ],
      })),
    ],
  };
}

export function rangeCenterValue(item) {
  return item.mid ?? item.value ?? (Number.isFinite(item.base) ? item.base : undefined);
}

const rangeValueFormatter = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 21 });

export function formatRangeValue(value) {
  return Number.isFinite(value) ? rangeValueFormatter.format(value) : String(value ?? '');
}

export function rangeAxisTickIndices(bounds) {
  if (bounds.length < 2) return bounds.map((_bound, index) => index);
  const selected = [0];
  const last = bounds.length - 1;
  let right = bounds[0].right;
  for (let index = 1; index < last; index++) {
    if (bounds[index].left >= right + 8 && bounds[index].right <= bounds[last].left - 8) {
      selected.push(index);
      right = bounds[index].right;
    }
  }
  selected.push(last);
  return selected;
}

export function withRangeTones(figure) {
  if (figure.type !== 'range' || !Array.isArray(figure.data?.items)) return figure;
  return {
    ...figure,
    data: {
      ...figure.data,
      items: figure.data.items.map((item) => {
        if (item.tone) return item;
        const label = String(item.label ?? '').toLowerCase();
        const tone = label.includes('stress') || label.includes('bear') ? 'risk'
          : label.includes('bull') ? 'positive' : 'neutral';
        return { ...item, tone };
      }),
    },
  };
}

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
