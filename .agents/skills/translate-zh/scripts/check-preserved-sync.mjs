#!/usr/bin/env node
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { syncPreservedFields } from './sync-preserved-fields.mjs';

const folder = resolve('.translate-cache', `preserved-sync-check-${process.pid}`);

try {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'summary-card.yaml'), yaml.dump({
    schemaVersion: 'report-v2',
    artifact: 'summary-card',
    revision: {
      status: 'superseded',
      supersededByRunId: '20990101000000-next',
      refreshReason: 'Scheduled refresh',
    },
    summary: {
      headline: 'English headline',
    },
  }));
  writeFileSync(join(folder, 'summary-card.zh.yaml'), yaml.dump({
    schemaVersion: 'report-v2',
    artifact: 'summary-card',
    revision: {
      status: 'current',
      supersededByRunId: null,
      refreshReason: null,
    },
    summary: {
      headline: '中文结论',
    },
  }));

  const changed = syncPreservedFields(folder);
  const result = yaml.load(readFileSync(join(folder, 'summary-card.zh.yaml'), 'utf8'));
  const failures = [
    [changed.includes('summary-card.zh.yaml'), 'stale overlay was not updated'],
    [result.revision.status === 'superseded', 'revision.status was not synchronized'],
    [result.revision.supersededByRunId === '20990101000000-next', 'supersededByRunId was not synchronized'],
    [result.revision.refreshReason === 'Scheduled refresh', 'refreshReason was not synchronized'],
    [result.summary.headline === '中文结论', 'translated headline was overwritten'],
  ].filter(([ok]) => !ok).map(([, message]) => message);
  if (failures.length > 0) throw new Error(failures.join('; '));
  console.log('[check-preserved-sync] ✓ preserved fields synchronized without replacing translated text.');
} catch (error) {
  console.error(`[check-preserved-sync] ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(folder, { recursive: true, force: true });
}
