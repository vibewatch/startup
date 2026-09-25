import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';
import type { Loader } from 'astro/loaders';

const REPORTS_DIR = resolve(process.cwd(), '..', 'reports');
const SCHEMA_VERSION = 'report-v2' as const;
// Bump when the loader's parsing surface (loadReportCard / parseData inputs /
// Zod schema in content.config.ts) changes so cached digests in
// .astro/data-store.json invalidate everywhere.
const LOADER_VERSION = '2' as const;

export type YamlRecord = Record<string, unknown>;

export interface ReportCardData extends YamlRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  artifact: 'summary-card';
  slug: string;
  runDate: string;
  company: {
    name: string;
    website: string | null;
    sector: string | null;
    stage: string | null;
    headquarters: string | null;
    shortDescription: string | null;
  };
  revision: {
    status: 'current' | 'superseded';
    refreshOfRunId: string | null;
    supersededByRunId: string | null;
    refreshReason: string | null;
    refreshOfFolderSlug: string | null;
    supersededByFolderSlug: string | null;
  };
  headline: string;
  recommendation: string;
  confidence: string;
  riskRating: string;
  valuationStance: string;
  overallScore: number;
  sourceStats: {
    sourcesRetained: number;
    claimsReviewed: number;
    domainCount: number;
    adverseSourceCount: number;
    openQuestionCount: number;
    documentedGapQuestionCount: number;
    blockingQuestionCount: number;
    averageSourceAgeDays: number | null;
  };
  keyMetrics: Record<string, number | null>;
  topStrengths: string[];
  topRisks: string[];
  unresolvedGaps: string[];
  runId: string;
  runTimestamp: string;
  folderSlug: string;
}

export interface ReportStageFiles {
  fullReport: YamlRecord | null;
  summaryCard: ReportCardData | null;
  evidence: YamlRecord | null;
}

export interface ReportStageFilesZh {
  fullReport: YamlRecord | null;
  summaryCard: YamlRecord | null;
}

export interface CardOverlayZh {
  headline: string | null;
  topStrengths: string[] | null;
  topRisks: string[] | null;
  unresolvedGaps: string[] | null;
  companyShortDescription: string | null;
  companySector: string | null;
  companyStage: string | null;
}

interface FileFingerprint {
  mtimeMs: number;
  size: number;
}

interface YamlCacheEntry {
  fingerprint: FileFingerprint;
  value: YamlRecord | null;
}

interface ReportCardCacheEntry {
  fingerprint: FileFingerprint;
  value: ReportCardData | null;
}

interface CardOverlayZhCacheEntry {
  fingerprint: FileFingerprint;
  value: CardOverlayZh | null;
}

const yamlCache = new Map<string, YamlCacheEntry>();
const reportCardCache = new Map<string, ReportCardCacheEntry>();
const cardOverlayZhCache = new Map<string, CardOverlayZhCacheEntry>();

const RUN_ID_RE = /^(\d{14})-(.+)$/;

// ---------------------------------------------------------------------------
// run discovery
// ---------------------------------------------------------------------------

function listRuns(): string[] {
  try {
    return readdirSync(REPORTS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith('.') && !name.startsWith('_'))
      .sort()
      .reverse();
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return [];
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[reports-loader] Failed to list ${REPORTS_DIR}: ${message}`);
    return [];
  }
}

function fileFingerprint(path: string): FileFingerprint | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return null;
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return null;
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[reports-loader] Failed to stat ${path}: ${message}`);
    return null;
  }
}

function sameFingerprint(a: FileFingerprint | null | undefined, b: FileFingerprint | null | undefined): boolean {
  return !!a && !!b && a.mtimeMs === b.mtimeMs && a.size === b.size;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

function isRecord(value: unknown): value is YamlRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown): YamlRecord {
  return isRecord(value) ? value : {};
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function readYamlCacheEntry(path: string): YamlCacheEntry | null {
  const fingerprint = fileFingerprint(path);
  if (!fingerprint) {
    yamlCache.delete(path);
    return null;
  }

  const cached = yamlCache.get(path);
  if (sameFingerprint(cached?.fingerprint, fingerprint)) return cached!;

  const value = parseYamlFile(path);
  const entry = { fingerprint, value };
  yamlCache.set(path, entry);
  return entry;
}

function parseYamlFile(path: string): YamlRecord | null {
  try {
    const raw: unknown = yaml.load(readFileSync(path, 'utf8'));
    const normalized = normalizeDates(raw);
    if (!isRecord(normalized)) {
      console.warn(`[reports-loader] YAML root is not an object for ${path}`);
      return null;
    }
    return normalized;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[reports-loader] YAML parse failed for ${path}: ${message}`);
    return null;
  }
}

function shortHash(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 6);
}

function parseRunId(runId: string): { runTimestamp: string; folderSlug: string } {
  const match = runId.match(RUN_ID_RE);
  if (match) return { runTimestamp: match[1]!, folderSlug: `${match[2]!}-${shortHash(runId)}` };
  return { runTimestamp: '00000000000000', folderSlug: `${runId}-${shortHash(runId)}` };
}

function relatedFolderSlug(runId: unknown): string | null {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) return null;
  return parseRunId(runId).folderSlug;
}

function normalizeRevision(raw: YamlRecord): ReportCardData['revision'] {
  const revision = asRecord(raw.revision);
  const status = revision.status === 'superseded' ? 'superseded' : 'current';
  const nullable = (field: string) => stringOrNull(revision[field]);
  const refreshOfRunId = nullable('refreshOfRunId');
  const supersededByRunId = nullable('supersededByRunId');
  return {
    status,
    refreshOfRunId,
    supersededByRunId,
    refreshReason: nullable('refreshReason'),
    refreshOfFolderSlug: relatedFolderSlug(refreshOfRunId),
    supersededByFolderSlug: relatedFolderSlug(supersededByRunId),
  };
}

// ---------------------------------------------------------------------------
// YAML date normalization
// ---------------------------------------------------------------------------

function normalizeDates(value: unknown): unknown {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString().slice(0, 10);
  if (Array.isArray(value)) return value.map(normalizeDates);
  if (!value || typeof value !== 'object') return value;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) out[key] = normalizeDates(child);
  return out;
}

function readYaml(path: string): YamlRecord | null {
  return readYamlCacheEntry(path)?.value ?? null;
}

// ---------------------------------------------------------------------------
// report card normalization
// ---------------------------------------------------------------------------

function normalizeReportCard(raw: YamlRecord, runId: string): ReportCardData {
  const { runTimestamp, folderSlug } = parseRunId(runId);
  const company = asRecord(raw.company);
  const summary = asRecord(raw.summary);
  const metrics = asRecord(summary.keyMetrics);
  const sourceStats = asRecord(raw.sourceStats);
  const companyName = stringOr(company.name, 'Unknown company');
  return {
    schemaVersion: SCHEMA_VERSION,
    artifact: 'summary-card',
    slug: stringOr(raw.slug, runId),
    runDate: stringOr(raw.runDate, '1970-01-01'),
    company: {
      name: companyName,
      website: stringOrNull(company.website),
      sector: stringOrNull(company.sector),
      stage: stringOrNull(company.stage),
      headquarters: stringOrNull(company.headquarters),
      shortDescription: stringOrNull(company.shortDescription),
    },
    revision: normalizeRevision(raw),
    headline: stringOr(summary.headline, `${companyName} diligence report`),
    recommendation: typeof summary.recommendation === 'string' ? summary.recommendation : 'research-more',
    confidence: stringOr(summary.confidence, 'low'),
    riskRating: stringOr(summary.riskRating, 'unknown'),
    valuationStance: stringOr(summary.valuationStance, 'unknown'),
    overallScore: numberOr(summary.overallScore, 0),
    sourceStats: {
      sourcesRetained: numberOr(sourceStats.sourcesRetained, 0),
      claimsReviewed: numberOr(sourceStats.claimsReviewed, 0),
      domainCount: numberOr(sourceStats.domainCount, 0),
      adverseSourceCount: numberOr(sourceStats.adverseSourceCount, 0),
      openQuestionCount: numberOr(sourceStats.openQuestionCount, 0),
      documentedGapQuestionCount: numberOr(sourceStats.documentedGapQuestionCount, 0),
      blockingQuestionCount: numberOr(sourceStats.blockingQuestionCount, 0),
      averageSourceAgeDays: numberOrNull(sourceStats.averageSourceAgeDays),
    },
    keyMetrics: {
      valuationUsdM: numberOrNull(metrics.valuationUsdM),
      revenueRunRateUsdM: numberOrNull(metrics.revenueRunRateUsdM),
      arrUsdM: numberOrNull(metrics.arrUsdM),
      revenueGrowthYoYPct: numberOrNull(metrics.revenueGrowthYoYPct),
      grossMarginPct: numberOrNull(metrics.grossMarginPct),
      nrrPct: numberOrNull(metrics.nrrPct),
      totalRaisedUsdM: numberOrNull(metrics.totalRaisedUsdM),
      customerCount: numberOrNull(metrics.customerCount),
      headcount: numberOrNull(metrics.headcount),
    },
    topStrengths: stringList(summary.topStrengths),
    topRisks: stringList(summary.topRisks),
    unresolvedGaps: stringList(summary.unresolvedGaps),
    runId,
    runTimestamp,
    folderSlug,
  };
}

// ---------------------------------------------------------------------------
// path resolution
// ---------------------------------------------------------------------------

const SUMMARY_CARD_FILE = 'summary-card.yaml';

function reportCardPath(folder: string): string {
  return join(folder, SUMMARY_CARD_FILE);
}

function readStageYaml(folder: string, basename: string): YamlRecord | null {
  return readYaml(join(folder, `${basename}.yaml`));
}

// Locale overlay reader: looks for `<basename>.zh.yaml` next to the canonical
// `<basename>.yaml`. Returns null when no overlay exists; pages then fall
// back to the English data.
function readLocaleStageYaml(folder: string, basename: string, locale: 'zh'): YamlRecord | null {
  return readYaml(join(folder, `${basename}.${locale}.yaml`));
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

// Digest a single file alongside LOADER_VERSION so any change to either the
// file bytes or the loader's parsing surface (via the version constant)
// re-keys the entry in Astro's persistent content store.
function fileDigest(path: string): string {
  return createHash('sha1').update(LOADER_VERSION).update('\0').update(readFileSync(path)).digest('hex');
}

export function reportsLoader(): Loader {
  return {
    name: 'startup-reports-v2-loader',
    load: async ({ store, parseData, logger }) => {
      const runs = listRuns();
      if (runs.length === 0) {
        logger.info(`[reports-loader] No report runs found in ${REPORTS_DIR}`);
        for (const id of Array.from(store.keys())) store.delete(id);
        return;
      }
      logger.info(`[reports-loader] Loading ${runs.length} report run(s) from ${REPORTS_DIR}`);

      let loaded = 0;
      let reused = 0;
      let skipped = 0;
      const seen = new Set<string>();

      for (const runId of runs) {
        const cardPath = reportCardPath(join(REPORTS_DIR, runId));
        if (!existsSync(cardPath)) {
          skipped += 1;
          continue;
        }
        seen.add(runId);

        let digest: string;
        try {
          digest = fileDigest(cardPath);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error(`[reports-loader] ${runId}: failed to read summary-card.yaml — ${message}`);
          skipped += 1;
          continue;
        }

        const existing = store.get(runId);
        if (existing && existing.digest === digest) {
          reused += 1;
          continue;
        }

        const dataForRun = loadReportCard(runId);
        if (!dataForRun) {
          skipped += 1;
          continue;
        }
        const data = await parseData({ id: runId, data: dataForRun });
        store.set({ id: runId, data, digest });
        loaded += 1;
      }

      let pruned = 0;
      for (const id of Array.from(store.keys())) {
        if (!seen.has(id)) {
          store.delete(id);
          pruned += 1;
        }
      }

      logger.info(`[reports-loader] ✓ ${loaded} new/changed, ${reused} cached, ${pruned} pruned, ${skipped} skipped (of ${runs.length})`);
    },
  };
}

// English stage files only — the English page detail loads via this.
export function loadStageFiles(runId: string): ReportStageFiles {
  const folder = join(REPORTS_DIR, runId);
  return {
    fullReport: readStageYaml(folder, 'full-report'),
    summaryCard: loadReportCard(runId),
    evidence: readStageYaml(folder, 'evidence'),
  };
}

// Chinese overlay stage files. Each field is null when the corresponding
// final-artifact `*.zh.yaml` sibling has not been written yet — the Chinese
// detail page merges these onto the English stages so untranslated fields
// fall through.
export function loadStageFilesZh(runId: string): ReportStageFilesZh {
  const folder = join(REPORTS_DIR, runId);
  return {
    fullReport: readLocaleStageYaml(folder, 'full-report', 'zh'),
    summaryCard: readLocaleStageYaml(folder, 'summary-card', 'zh'),
  };
}

// Chinese overlay for the report card metadata used on list pages
// (homepage, archive, top-rated). Returns null when no overlay exists.
export function loadCardOverlayZh(runId: string): CardOverlayZh | null {
  const folder = join(REPORTS_DIR, runId);
  const path = join(folder, 'summary-card.zh.yaml');
  const rawEntry = readYamlCacheEntry(path);
  if (!rawEntry) {
    cardOverlayZhCache.delete(runId);
    return null;
  }

  const cached = cardOverlayZhCache.get(runId);
  if (sameFingerprint(cached?.fingerprint, rawEntry.fingerprint)) return cached!.value;

  const summary = asRecord(rawEntry.value?.summary);
  const company = asRecord(rawEntry.value?.company);
  const value: CardOverlayZh | null = rawEntry.value
    ? {
        headline: stringOrNull(summary.headline),
        topStrengths: stringList(summary.topStrengths),
        topRisks: stringList(summary.topRisks),
        unresolvedGaps: stringList(summary.unresolvedGaps),
        companyShortDescription: stringOrNull(company.shortDescription),
        companySector: stringOrNull(company.sector),
        companyStage: stringOrNull(company.stage),
      }
    : null;
  const normalized: CardOverlayZh | null = value
    ? {
        ...value,
        topStrengths: value.topStrengths?.length ? value.topStrengths : null,
        topRisks: value.topRisks?.length ? value.topRisks : null,
        unresolvedGaps: value.unresolvedGaps?.length ? value.unresolvedGaps : null,
      }
    : null;
  cardOverlayZhCache.set(runId, { fingerprint: rawEntry.fingerprint, value: normalized });
  return normalized;
}

function loadReportCard(runId: string): ReportCardData | null {
  const folder = join(REPORTS_DIR, runId);
  const path = reportCardPath(folder);
  const rawEntry = readYamlCacheEntry(path);
  if (!rawEntry) {
    reportCardCache.delete(runId);
    return null;
  }

  const cached = reportCardCache.get(runId);
  if (sameFingerprint(cached?.fingerprint, rawEntry.fingerprint)) return cached!.value;

  const value = rawEntry.value ? normalizeReportCard(rawEntry.value, runId) : null;
  reportCardCache.set(runId, { fingerprint: rawEntry.fingerprint, value });
  return value;
}
