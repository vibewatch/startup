import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { RevisionSchema } from './contracts/report-artifacts.schema.mjs';
import { FINAL_ARTIFACTS, REPORT_META_FILE, normalizeRevision, readYaml, reportsDir } from './utils.mjs';

function artifactFiles(folder, fileExists) {
  return [
    FINAL_ARTIFACTS.summaryCard.file,
    FINAL_ARTIFACTS.fullReport.file,
    ...['summary-card.zh.yaml', 'full-report.zh.yaml'].filter(file => fileExists(join(folder, file))),
  ];
}

export function refreshArtifactsAreInSync(folder, expectedRevision, readDocument = readYaml, fileExists = existsSync) {
  return artifactFiles(folder, fileExists).every(file => {
    const path = join(folder, file);
    if (!fileExists(path)) return false;
    const parsed = RevisionSchema.safeParse(readDocument(path)?.revision);
    return parsed.success && JSON.stringify(normalizeRevision(parsed.data)) === JSON.stringify(expectedRevision);
  });
}

export function checkRefreshReadback({ reportFolder, runId, refreshContext }, readDocument = readYaml, fileExists = existsSync) {
  if (!refreshContext) return [];
  const issues = [];
  for (const previous of [false, true]) {
    const folder = previous ? join(reportsDir, refreshContext.refreshOfRunId) : reportFolder;
    const files = [REPORT_META_FILE, ...artifactFiles(folder, fileExists)];
    let referenceRevision;
    for (const file of files) {
      const path = join(folder, file);
      try {
        const parsed = RevisionSchema.safeParse(readDocument(path)?.revision);
        if (!parsed.success) throw new Error('Missing or malformed explicit revision');
        const revision = normalizeRevision(parsed.data);
        if (previous
          ? revision.status !== 'superseded' || revision.supersededByRunId !== runId
          : revision.status !== 'current' || revision.refreshOfRunId !== refreshContext.refreshOfRunId
            || revision.supersededByRunId !== null || revision.refreshReason !== refreshContext.refreshReason) {
          throw new Error('Revision does not match the cached refresh relationship');
        }
        referenceRevision ??= JSON.stringify(revision);
        if (JSON.stringify(revision) !== referenceRevision) {
          throw new Error('Revision differs from the report metadata');
        }
      } catch (error) {
        issues.push({
          path: `${path}:revision`,
          code: 'refreshReadbackMismatch',
          message: error.message,
          fix: 'Run finalize-report.mjs with --refresh using the unchanged cached context. Let link-refresh update both reports and preserved Chinese fields; do not hand-edit revisions or rebuild historical content.',
        });
      }
    }
  }
  return issues;
}
