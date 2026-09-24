export type ReportRecord = Record<string, unknown>;

export interface Claim extends ReportRecord {
  id: string;
  statement?: string;
  confidence?: string;
  sourceRefs?: string[];
}

export interface Source extends ReportRecord {
  id: string;
  publisher?: string;
  title?: string;
  url?: string;
  keyQuote?: string;
}

export interface ReportBlock extends ReportRecord {
  type?: string;
  body?: unknown;
  items?: unknown[];
  equation?: unknown;
  calloutType?: string | null;
  title?: string | null;
  claimRefs?: string[];
  tableRef?: string;
  figureRef?: string;
}

export interface ReportTable extends ReportRecord {
  id?: string;
  title?: string | null;
  columns?: unknown[];
  rows?: unknown[][];
  notes?: unknown;
  claimRefs?: string[];
}

export interface ReportFigure extends ReportRecord {
  id?: string;
  title?: string;
  type?: string;
  summary?: string;
  approximationNotes?: string;
  data?: unknown;
  claimRefs?: string[];
}

export interface CoverFact extends ReportRecord {
  label?: unknown;
  value?: unknown;
  unit?: unknown;
  claimRefs?: string[];
}

export interface Founder extends ReportRecord {
  name?: string;
}

export interface CompanyProfile extends ReportRecord {
  heading?: unknown;
  summary?: unknown;
  body?: unknown;
  foundedDate?: unknown;
  founders?: Founder[];
  foundingLocation?: unknown;
  headquarters?: unknown;
  productSummary?: unknown;
  customerFocus?: unknown;
  businessModel?: unknown;
  stage?: unknown;
  fundingStatus?: unknown;
  claimRefs?: string[];
}

export interface ReportSection extends ReportRecord {
  number?: string | number;
  title?: string;
  blocks?: ReportBlock[];
}

export interface ReportChapter extends ReportRecord {
  number?: string | number;
  title?: string;
  sections?: ReportSection[];
}

export interface ReportAppendix extends ReportRecord {
  id?: string | number;
  title?: string;
  blocks?: ReportBlock[];
}

export interface FullReport extends ReportRecord {
  company?: { name?: string };
  subtitle?: string | null;
  coverFacts?: CoverFact[];
  companyProfile?: CompanyProfile;
  chapters?: ReportChapter[];
  appendices?: ReportAppendix[];
  figures?: ReportFigure[];
  tables?: ReportTable[];
  disclaimer?: string;
}

export interface EvidenceLedger extends ReportRecord {
  claims?: Claim[];
  sources?: Source[];
}

export function isRecord(value: unknown): value is ReportRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function asRecord(value: unknown): ReportRecord {
  return isRecord(value) ? value : {};
}

export function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function claimRefs(value: unknown, limit = 6): string[] {
  return asArray<string>(isRecord(value) ? value.claimRefs : null).slice(0, limit);
}
