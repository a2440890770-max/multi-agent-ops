import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { validateStructuredResult } from './structured-model.js';

const schema = z.strictObject({
  versionId: z.string(),
  decision: z.enum(['pass', 'revise']),
  issues: z.array(z.strictObject({ blocking: z.boolean(), reason: z.string() })),
});
const data = {
  versionId: 'v2',
  decision: 'revise',
  issues: [{ blocking: true, reason: 'Test issue' }],
};
const success = { subtype: 'success', is_error: false } as const;

test('只有 SDK 成功且 structured_output 通过 Schema 才返回可用数据', () => {
  assert.deepEqual(validateStructuredResult({ ...success, structured_output: data }, schema), data);
});

test('SDK 的 success 子类型携带 is_error=true 时仍必须拒绝', () => {
  assert.throws(
    () =>
      validateStructuredResult(
        { subtype: 'success', is_error: true, structured_output: data },
        schema,
      ),
    /SDK 调用失败/,
  );
  assert.throws(
    () =>
      validateStructuredResult(
        { subtype: 'error_max_structured_output_retries', is_error: true, structured_output: data },
        schema,
      ),
    /SDK 调用失败/,
  );
});

test('缺少 structured_output 时不得退回解析普通 JSON 文本', () => {
  const ordinaryTextResult = { ...success, result: JSON.stringify(data) };
  assert.throws(
    () => validateStructuredResult(ordinaryTextResult, schema),
    /没有返回 structured_output/,
  );
});

test('拒绝缺失字段、错误类型、非法枚举、额外字段及 JSON 字符串', () => {
  for (const value of [
    { decision: 'pass', issues: [] },
    { ...data, versionId: 2 },
    { ...data, decision: 'approved' },
    { ...data, extra: true },
    { ...data, issues: [{ blocking: 'yes', reason: 'private rejected content' }] },
    JSON.stringify(data),
  ]) {
    assert.throws(
      () => validateStructuredResult({ ...success, structured_output: value }, schema),
      /校验失败/,
    );
  }
});

test('校验错误不输出被拒绝的业务内容', () => {
  assert.throws(
    () =>
      validateStructuredResult(
        { ...success, structured_output: { ...data, decision: 'private rejected content' } },
        schema,
      ),
    (error: unknown) =>
      error instanceof Error && !error.message.includes('private rejected content'),
  );
});
