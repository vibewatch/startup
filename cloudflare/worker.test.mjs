import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import yaml from 'js-yaml';
import worker from './worker.js';

const env = { GITHUB_TOKEN: 'test-token', GITHUB_REPO: 'example/startup' };
const eventAt = (hour, minute = 0) => ({
  cron: '0 * * * *',
  scheduledTime: Date.UTC(2026, 8, 25, hour, minute),
});
const nameFromUrl = (url) => url.split('/').at(-2);

test('hourly dispatches use current workflows and declared inputs without model overrides', async (t) => {
  const calls = [];
  t.mock.method(console, 'log', () => {});
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return new Response(null, { status: 204 });
  });
  const counts = new Map();
  for (let hour = 0; hour < 24; hour += 1) {
    calls.length = 0;
    await worker.scheduled(eventAt(hour), env);
    const expected = [
      ...(hour % 6 === 0 ? ['research-unicorns.yml'] : []),
      ...(hour % 2 === 0 ? ['translate-reports-zh.yml'] : []),
      ...(hour === 2 ? ['refresh-portfolio.yml'] : []),
    ];
    assert.deepEqual(calls.map(({ url }) => nameFromUrl(url)), expected);
    for (const { url, options, body } of calls) {
      const name = nameFromUrl(url);
      const workflow = yaml.load(readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8'));
      const inputs = workflow.on.workflow_dispatch.inputs;
      assert.equal(url, `https://api.github.com/repos/example/startup/actions/workflows/${name}/dispatches`);
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, 'Bearer test-token');
      assert.equal(options.headers['Content-Type'], 'application/json');
      assert(options.signal instanceof AbortSignal);
      assert.equal(body.ref, 'main');
      assert(!Object.hasOwn(body.inputs, 'model'));
      for (const [key, value] of Object.entries(body.inputs)) {
        assert(Object.hasOwn(inputs, key), `${name}: undeclared input ${key}`);
        assert.equal(typeof value, 'string');
        if (inputs[key].options) assert(inputs[key].options.includes(value));
      }
      for (const [key, definition] of Object.entries(inputs)) {
        if (definition.required && definition.default === undefined) {
          assert(Object.hasOwn(body.inputs, key), `${name}: required input ${key} missing`);
        }
      }
      if (name === 'research-unicorns.yml') assert.equal(body.inputs.unicornCount, '1');
      if (name === 'translate-reports-zh.yml') assert.equal(body.inputs.reportCount, '1');
      if (name === 'refresh-portfolio.yml') assert.equal(body.inputs.maxBatch, '0');
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  assert.deepEqual(Object.fromEntries(counts), {
    'research-unicorns.yml': 4,
    'translate-reports-zh.yml': 12,
    'refresh-portfolio.yml': 1,
  });
});

test('uses scheduled UTC time and the configured ref', async (t) => {
  t.mock.method(console, 'log', () => {});
  const fetch = t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(JSON.parse(options.body).ref, 'release');
    return new Response(null, { status: 204 });
  });
  await worker.scheduled(eventAt(6), { ...env, GITHUB_REF: 'release' });
  assert.equal(fetch.mock.callCount(), 2);
});

test('idle hours and off-minute invocations do not dispatch', async (t) => {
  t.mock.method(console, 'log', () => {});
  const fetch = t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Unexpected dispatch');
  });
  await worker.scheduled(eventAt(1), env);
  await worker.scheduled(eventAt(6, 1), env);
  assert.equal(fetch.mock.callCount(), 0);
});

test('invalid time and missing credentials fail without making requests', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Unexpected dispatch');
  });
  await assert.rejects(worker.scheduled({ scheduledTime: 'invalid' }, env), /Invalid scheduledTime/);
  await assert.rejects(worker.scheduled(eventAt(0), { GITHUB_REPO: env.GITHUB_REPO }), /Missing GITHUB_TOKEN/);
  await assert.rejects(worker.scheduled(eventAt(0), { GITHUB_TOKEN: env.GITHUB_TOKEN }), /owner\/repo/);
  await assert.rejects(worker.scheduled(eventAt(0), { ...env, GITHUB_REPO: 'invalid' }), /owner\/repo/);
  assert.equal(fetch.mock.callCount(), 0);
});

test('GitHub errors remain failures without preventing other due dispatches', async (t) => {
  t.mock.method(console, 'log', () => {});
  const fetch = t.mock.method(globalThis, 'fetch', async (url) => (
    new Response(null, { status: nameFromUrl(url) === 'research-unicorns.yml' ? 422 : 204 })
  ));
  await assert.rejects(worker.scheduled(eventAt(0), env), /research-unicorns\.yml.*HTTP 422/);
  assert.equal(fetch.mock.callCount(), 2);
});

test('network failures propagate with the workflow name', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('network unavailable');
  });
  await assert.rejects(worker.scheduled(eventAt(4), env), /translate-reports-zh\.yml.*network unavailable/);
});

test('timed-out requests fail rather than reporting a successful dispatch', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new DOMException('request timed out', 'TimeoutError');
  });
  await assert.rejects(worker.scheduled(eventAt(4), env), /translate-reports-zh\.yml.*request timed out/);
});

test('legacy workflow files are absent and native schedules stay intact', () => {
  for (const name of ['unicorns.yml', 'translate-zh.yml', 'deploy.yml', 'skill-review.md']) {
    assert(!existsSync(new URL(`../.github/workflows/${name}`, import.meta.url)), `${name} is obsolete`);
  }
  for (const [name, cron] of [
    ['research-unicorns.yml', '7 */6 * * *'],
    ['translate-reports-zh.yml', '17 */2 * * *'],
    ['refresh-portfolio.yml', '17 2 * * *'],
  ]) {
    const workflow = yaml.load(readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8'));
    assert.deepEqual(workflow.on.schedule, [{ cron }]);
  }
});
