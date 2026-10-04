import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hasText, isRunId, readYaml, researchCacheDir } from './utils.mjs';

export const REFRESH_REASON_REVIEW_FILE = 'refresh-reason-review.json';

export function loadRefreshContext(runId, cacheDir = researchCacheDir(runId)) {
  if (!isRunId(runId)) throw new Error('Invalid refresh run id');
  const contextPath = join(cacheDir, 'refresh-context.yaml');
  const reviewPath = join(cacheDir, REFRESH_REASON_REVIEW_FILE);
  if (!existsSync(contextPath)) {
    if (existsSync(reviewPath)) throw new Error('Refresh reason review requires its original refresh-context.yaml');
    return { context: null, originalContext: null, review: null };
  }
  const originalContext = readYaml(contextPath);
  if (!existsSync(reviewPath)) return { context: originalContext, originalContext, review: null };
  const review = JSON.parse(readFileSync(reviewPath, 'utf8'));
  const contextSha256 = createHash('sha256').update(readFileSync(contextPath)).digest('hex');
  if (review?.schemaVersion !== 'refresh-reason-review-v1'
      || review.runId !== runId || originalContext?.mode !== 'refresh'
      || originalContext.newRunId !== runId
      || !isRunId(originalContext.refreshOfRunId) || originalContext.refreshOfRunId === runId
      || review.refreshOfRunId !== originalContext.refreshOfRunId
      || review.contextSha256 !== contextSha256
      || !hasText(originalContext.refreshReason) || review.originalReason !== originalContext.refreshReason
      || !hasText(review.reviewedReason) || review.reviewedReason === review.originalReason
      || !hasText(review.reviewedAt) || !Number.isFinite(Date.parse(review.reviewedAt))) {
    throw new Error(`Invalid or stale refresh reason review: ${reviewPath}`);
  }
  return {
    context: { ...originalContext, refreshReason: review.reviewedReason },
    originalContext,
    review,
  };
}

export function recordRefreshReasonReview(runId, reviewedReason, cacheDir = researchCacheDir(runId)) {
  const { originalContext, review } = loadRefreshContext(runId, cacheDir);
  if (!hasText(reviewedReason) || originalContext?.mode !== 'refresh'
      || originalContext.newRunId !== runId || !isRunId(originalContext.refreshOfRunId)
      || originalContext.refreshOfRunId === runId || !hasText(originalContext.refreshReason)
      || reviewedReason === originalContext.refreshReason) {
    throw new Error('A distinct reviewed reason and an authentic matching refresh context are required');
  }
  if (review) {
    if (review.reviewedReason !== reviewedReason) throw new Error('Refusing to overwrite an existing refresh reason review');
    return review;
  }
  const next = {
    schemaVersion: 'refresh-reason-review-v1',
    runId,
    refreshOfRunId: originalContext.refreshOfRunId,
    contextSha256: createHash('sha256').update(readFileSync(join(cacheDir, 'refresh-context.yaml'))).digest('hex'),
    originalReason: originalContext.refreshReason,
    reviewedReason,
    reviewedAt: new Date().toISOString(),
  };
  writeFileSync(join(cacheDir, REFRESH_REASON_REVIEW_FILE), `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx' });
  return next;
}
