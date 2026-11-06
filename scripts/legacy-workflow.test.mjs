import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isLegacyManualMigration,
  legacyManualMigration,
  normalizeLegacyClarificationCheck,
} from './legacy-workflow-migrations.mjs';
import { isCompatibleMigration, editorialMigration } from './compatible-migrations.mjs';
test('兼容身份必须同时匹配原始 SQL 哈希和时间，未知记录保持拒绝', () => {
  for (const [identify, entry] of [
    [isLegacyManualMigration, legacyManualMigration],
    [isCompatibleMigration, editorialMigration],
  ]) {
    assert.equal(identify({ hash: entry.hash, created_at: String(entry.createdAt) }), true);
    assert.equal(identify({ hash: 'modified', created_at: entry.createdAt }), false);
    assert.equal(identify({ hash: entry.hash, created_at: entry.createdAt + 1 }), false);
  }
});
test('恢复归一化只接受已知等价的 AND 括号，不放宽字数或逻辑', () => {
  const restored =
    'CHECK (((char_length(answer) >= 1) AND (char_length(answer) <= 4000) AND (char_length(btrim(answer)) > 0) AND ((char_length(question) >= 1) AND (char_length(question) <= 4000))))';
  assert.notEqual(normalizeLegacyClarificationCheck(restored), restored);
  for (const changed of [
    restored.replace('<= 4000', '<= 9000'),
    restored.replace(' AND ', ' OR '),
    restored.replace('btrim(answer)', 'answer'),
  ])
    assert.equal(normalizeLegacyClarificationCheck(changed), changed);
});
