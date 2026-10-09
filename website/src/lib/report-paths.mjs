import { createHash } from 'node:crypto';

/** @param {string} runId */
export function parseReportRunId(runId) {
  const hash = createHash('sha1').update(runId).digest('hex').slice(0, 6);
  const match = runId.match(/^(\d{14})-(.+)$/);
  return {
    runTimestamp: match?.[1] ?? '00000000000000',
    folderSlug: `${match?.[2] ?? runId}-${hash}`,
  };
}

/** @param {Record<string, string>} redirects */
export function reportRedirectRoutes(redirects, base = '/') {
  const prefix = base.endsWith('/') ? base : `${base}/`;
  /** @type {Record<string, string>} */
  const routes = {};
  for (const [from, to] of Object.entries(redirects)) {
    const oldSlug = parseReportRunId(from).folderSlug;
    const newSlug = parseReportRunId(to).folderSlug;
    routes[`/${oldSlug}/`] = `${prefix}${newSlug}/`;
    routes[`/zh/${oldSlug}/`] = `${prefix}zh/${newSlug}/`;
  }
  return routes;
}
