import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { firstDifference, normalizeUpdatedAtFunctionSource } from './migration-catalog.mjs';

const manifest = JSON.parse(
  readFileSync(new URL('../backend/drizzle/0000_baseline.catalog.json', import.meta.url), 'utf8'),
);
const canonical = manifest.schema.functions[0].source;

test('初始更新时间函数的 Windows 换行符不会误报结构差异', () => {
  const windowsSource = canonical.replaceAll('\n', '\r\n');
  assert.notEqual(windowsSource, canonical);
  assert.equal(normalizeUpdatedAtFunctionSource(windowsSource), canonical);
  assert.equal(normalizeUpdatedAtFunctionSource(canonical), canonical);
  const actual = structuredClone(manifest.schema);
  actual.functions[0].source = normalizeUpdatedAtFunctionSource(windowsSource);
  assert.equal(firstDifference(manifest.schema, actual), null);
});

test('函数行为变化继续被拒绝，不能通过换行符归一化掩盖', () => {
  for (const source of [
    canonical.replace('CURRENT_TIMESTAMP', 'clock_timestamp()'),
    canonical.replace('NEW.updated_at', 'NEW.created_at'),
    canonical.replace('RETURN NEW', 'RETURN NULL'),
  ]) {
    for (const value of [source, source.replaceAll('\n', '\r\n')]) {
      const actual = structuredClone(manifest.schema);
      actual.functions[0].source = normalizeUpdatedAtFunctionSource(value);
      assert.equal(firstDifference(manifest.schema, actual), 'schema.functions.0.source');
    }
  }
});

test('字符串、注释和其他函数正文不做通用替换', () => {
  for (const source of [
    "\r\nBEGIN\r\n  RAISE NOTICE 'line 1\r\nline 2';\r\n  RETURN NEW;\r\nEND;\r\n",
    canonical.replace('RETURN NEW;', '-- preserve source\r\n    RETURN NEW;'),
    canonical.replace('    NEW.updated_at', '\tNEW.updated_at'),
  ]) {
    assert.equal(normalizeUpdatedAtFunctionSource(source), source);
  }
});

test('函数安全属性和语言变化仍然参与结构核对', () => {
  for (const [key, value] of [
    ['security_definer', true],
    ['volatility', 's'],
    ['config', ['search_path=public']],
    ['language', 'sql'],
  ]) {
    const actual = structuredClone(manifest.schema);
    actual.functions[0][key] = value;
    assert.equal(firstDifference(manifest.schema, actual), `schema.functions.0.${key}`);
  }
});
