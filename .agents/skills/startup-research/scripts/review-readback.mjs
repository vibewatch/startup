import { isDeepStrictEqual } from 'node:util';

const fields = ['tokens', 'expectedBefore', 'exactReplacement'];
const hasOwn = (value, key) => value != null && Object.hasOwn(value, key);
const fieldPath = (tokens) => tokens.map((token, index) => typeof token === 'number'
  ? `[${token}]` : `${index ? '.' : ''}${token}`).join('');
const pathFor = (file, tokens) => `${file}:${fieldPath(tokens)}`;

export function hasReviewReadback(issues = []) {
  return issues.some((issue) => fields.some((key) => hasOwn(issue, key)));
}

export function prepareReviewReadback(issues, documents) {
  if (!hasReviewReadback(issues)) return null;
  const expected = structuredClone(documents);
  const targets = [];
  for (const issue of issues) {
    if (!fields.every((key) => hasOwn(issue, key))
        || !Array.isArray(issue.tokens) || issue.tokens.length === 0
        || issue.tokens.some((token) => typeof token === 'number'
          ? !Number.isSafeInteger(token) || token < 0
          : typeof token !== 'string' || !/^[A-Za-z_$][\w$-]*$/.test(token))) {
      throw new Error(`${issue.path}: exact reviews require tokens, expectedBefore and exactReplacement on every issue`);
    }
    const file = issue.path.split(':')[0];
    if (!documents.has(file) || issue.path !== pathFor(file, issue.tokens)) {
      throw new Error(`${issue.path}: tokens must identify the same existing authored-file path`);
    }
    if (targets.some((target) => target.file === file
        && target.tokens.slice(0, Math.min(target.tokens.length, issue.tokens.length))
          .every((token, index) => token === issue.tokens[index]))) {
      throw new Error(`${issue.path}: duplicate or overlapping exact-review targets`);
    }
    let before = documents.get(file);
    let parent = expected.get(file);
    for (const [index, token] of issue.tokens.entries()) {
      if (!before || typeof before !== 'object' || !hasOwn(before, token)
          || Array.isArray(before) !== (typeof token === 'number')) {
        throw new Error(`${issue.path}: exact-review target does not exist`);
      }
      before = before[token];
      if (index < issue.tokens.length - 1) {
        parent[token] = structuredClone(parent[token]);
        parent = parent[token];
      }
    }
    if (!isDeepStrictEqual(before, issue.expectedBefore)) {
      throw new Error(`${issue.path}: stale expectedBefore; review the current source before execution`);
    }
    parent[issue.tokens.at(-1)] = structuredClone(issue.exactReplacement);
    targets.push({ file, tokens: issue.tokens });
  }
  return { expected, assignmentCount: targets.length };
}

export function checkReviewReadback(readback, readDocument) {
  if (!readback) return [];
  const issues = [];
  const compare = (expected, actual, file, tokens = []) => {
    if (isDeepStrictEqual(expected, actual)) return;
    const objects = expected && actual && typeof expected === 'object' && typeof actual === 'object';
    if (objects && !Array.isArray(expected) && !Array.isArray(actual)
        && Object.getPrototypeOf(expected) === Object.prototype
        && Object.getPrototypeOf(actual) === Object.prototype) {
      for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
        compare(expected[key], actual[key], file, [...tokens, key]);
      }
      return;
    }
    if (objects && Array.isArray(expected) && Array.isArray(actual)
        && expected.length === actual.length
        && expected.some((value) => value && typeof value === 'object')) {
      expected.forEach((value, index) => compare(value, actual[index], file, [...tokens, index]));
      return;
    }
    issues.push({
      path: pathFor(file, tokens), code: 'reviewReadbackMismatch',
      message: 'The authored value does not match the approved exact-review scope.',
      expectedValue: expected, removeField: expected === undefined,
      fix: expected === undefined ? 'Remove this unapproved field.' : 'Restore expectedValue exactly, then finalize again.',
    });
  };
  for (const [file, expected] of readback.expected) {
    let actual;
    try {
      actual = readDocument(file);
    } catch (error) {
      issues.push({ path: file, code: 'reviewReadbackUnavailable', message: error.message,
        fix: 'Restore readable authored YAML without changing the approved review scope.' });
      continue;
    }
    compare(expected, actual, file);
  }
  return issues;
}
