import assert from 'node:assert/strict';
import test from 'node:test';
import { bailianAnthropicUrl, createContentModelOptions } from './content-model-config.js';

const env = {
  CONTENT_MODEL_PROVIDER: 'bailian',
  DASHSCOPE_API_KEY: 'bailian-fixture',
  BAILIAN_MODEL: 'deepseek-v4.1-flash',
  BAILIAN_BASE_URL: 'https://cn-beijing.maas.qianwenaiapi.com/compatible-mode/v1',
};

test('Content 百炼模式使用对应地址、密钥和模型，复用现有 SDK 权限设置', () => {
  const result = createContentModelOptions(env);
  assert.equal(result.provider, 'bailian');
  assert.equal(result.baseUrl, 'https://cn-beijing.maas.qianwenaiapi.com/apps/anthropic');
  assert.equal(result.options.model, 'deepseek-v4.1-flash');
  assert.equal(result.options.env?.ANTHROPIC_AUTH_TOKEN, 'bailian-fixture');
  assert.equal(result.options.env?.ANTHROPIC_BASE_URL, result.baseUrl);
  assert.deepEqual(result.options.tools, []);
  assert.deepEqual(result.options.settingSources, []);
});

test('提供商之间不复用密钥，宿主旧网关或数据库凭据不能进入 SDK', () => {
  assert.throws(
    () =>
      createContentModelOptions({
        ...env,
        DASHSCOPE_API_KEY: '',
        DEEPSEEK_API_KEY: 'wrong-provider',
      }),
    /DASHSCOPE_API_KEY/,
  );
  assert.throws(
    () =>
      createContentModelOptions({
        ...env,
        CONTENT_MODEL_PROVIDER: 'deepseek',
        DEEPSEEK_API_KEY: '',
      }),
    /DEEPSEEK_API_KEY/,
  );
  const result = createContentModelOptions({
    ...env,
    ANTHROPIC_BASE_URL: 'https://other.invalid',
    ANTHROPIC_API_KEY: 'other',
    DATABASE_URL: 'private',
  });
  assert.equal(result.options.env?.ANTHROPIC_BASE_URL, result.baseUrl);
  assert.equal(result.options.env?.ANTHROPIC_API_KEY, undefined);
  assert.equal(result.options.env?.DATABASE_URL, undefined);
});

test('默认 Content 提供商仍为 DeepSeek 官方，非法提供商/模型不会静默切换', () => {
  const result = createContentModelOptions({ DEEPSEEK_API_KEY: 'deepseek-fixture' });
  assert.equal(result.provider, 'deepseek');
  assert.equal(result.baseUrl, 'https://api.deepseek.com/anthropic');
  assert.throws(() => createContentModelOptions({ ...env, CONTENT_MODEL_PROVIDER: 'unknown' }));
  assert.throws(() => createContentModelOptions({ ...env, BAILIAN_MODEL: 'unverified-model' }));
});

test('API Host 或兼容地址只转换同一域名内的接口路径，拒绝凭据泄露目标', () => {
  for (const base of [
    'https://dashscope.aliyuncs.com',
    'https://workspace-1.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    'https://dashscope-intl.aliyuncs.com/apps/anthropic/',
  ]) {
    assert.equal(new URL(bailianAnthropicUrl(base)).hostname, new URL(base).hostname);
  }
  for (const base of [
    undefined,
    'http://dashscope.aliyuncs.com',
    'https://dashscope.aliyuncs.com.attacker.test',
    'https://attacker.test',
    'https://u:p@dashscope.aliyuncs.com',
    'https://dashscope.aliyuncs.com:8443',
    'https://dashscope.aliyuncs.com?token=x',
    'https://dashscope.aliyuncs.com/other',
    'https://cn-beijing.maas.qianwenaiapi.com.attacker.test',
  ])
    assert.throws(() => bailianAnthropicUrl(base));
});
