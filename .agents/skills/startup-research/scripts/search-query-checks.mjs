import { canonicalSourceUrl } from './utils.mjs';

export function executedSearchQueries(bundle, pool = null) {
  const allowed = pool && new Set(
    [...(pool.recommended ?? []), ...(pool.reserve ?? [])]
      .filter((candidate) => candidate.fetch?.ok)
      .map((candidate) => canonicalSourceUrl(candidate.url)),
  );
  return (bundle.searches ?? [])
    .filter((search) => typeof search.query === 'string'
      && search.response?.query === search.query
      && typeof search.response?.provider === 'string'
      && Array.isArray(search.response?.results))
    .map((search) => {
      const resultUrls = [...new Set(search.response.results
        .map((result) => canonicalSourceUrl(result.url))
        .filter((url) => url && (!allowed || allowed.has(url))))];
      return {
        search,
        record: {
          query: search.query,
          engine: search.response.provider,
          hits: search.response.results.length,
          resultUrls,
        },
      };
    })
    .filter(({ search, record }) => !pool
      || search.scope === 'global' || search.chapter === pool.key || record.resultUrls.length > 0)
    .map(({ record }) => record);
}

export function checkSearchQueryProvenance(evidence, executed, path) {
  const issues = [];
  const add = (code, field, message) => issues.push({
    code,
    path: `${path}:${field}`,
    message,
    fix: 'Copy literal query/provider/result counts from the executed search records. Retain only source IDs whose URLs occur in that query response; never invent a search or change the execution history.',
  });
  if (executed.length === 0) {
    add('searchQueryProvenanceMissing', 'searchQueries', 'No successful executed search records are available in the run bundle.');
    return issues;
  }
  const queries = evidence?.searchQueries;
  if (!Array.isArray(queries) || queries.length === 0) {
    add('searchQueryProvenanceMissing', 'searchQueries', 'The authored search log is missing or empty.');
    return issues;
  }
  const sourceUrls = new Map((evidence?.sources ?? [])
    .map((source) => [source.id, canonicalSourceUrl(source.url)]));
  for (const [index, query] of queries.entries()) {
    const field = `searchQueries[${index}]`;
    const matches = executed.filter((record) => record.query === query?.query);
    if (matches.length === 0) {
      add('searchQueryNotExecuted', field, `Query was not executed by shared discovery: ${JSON.stringify(query?.query)}.`);
      continue;
    }
    const matchingMetadata = matches.filter((record) => (
      (query.engine == null || query.engine === record.engine)
      && (query.hits == null || query.hits === record.hits)
    ));
    if (matchingMetadata.length === 0) {
      add('searchQueryMetadataMismatch', field, 'The recorded provider or result count does not match any execution of this query.');
      continue;
    }
    const refs = query.retainedSourceRefs ?? [];
    if (!Array.isArray(refs) || !matchingMetadata.some((record) => (
      refs.every((id) => sourceUrls.has(id) && record.resultUrls.includes(sourceUrls.get(id)))
    ))) {
      add('searchQuerySourceMismatch', field, 'A retained source was not returned by the recorded query execution.');
    }
  }
  return issues;
}
