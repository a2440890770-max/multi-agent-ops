import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeepSeekOptions, DEEPSEEK_BASE_URL, readDeepSeekConfig } from './model-config.js';

test('仅配置旧提供商凭证时必须失败，不能把它们当成 DeepSeek 凭证', () => {
  assert.throws(
    () => readDeepSeekConfig({ OPENAI_API_KEY: 'old-key', ANTHROPIC_AUTH_TOKEN: 'old-token' }),
    /DEEPSEEK_API_KEY/,
  );
  assert.throws(() => readDeepSeekConfig({ DEEPSEEK_API_KEY: '   ' }), /DEEPSEEK_API_KEY/);
});

test('默认主模型与审核模型均为 Flash；拒绝非官方模型标识', () => {
  const config = readDeepSeekConfig({ DEEPSEEK_API_KEY: 'fixture-key' });
  assert.equal(createDeepSeekOptions(config).model, 'deepseek-flash');
  assert.equal(createDeepSeekOptions(config, 'review').model, 'deepseek-flash');
  assert.throws(
    () => readDeepSeekConfig({ DEEPSEEK_API_KEY: 'fixture-key', DEEPSEEK_MODEL: 'gpt-6.1-sol' }),
    /模型必须/,
  );
});

test('宿主旧网关设置不能改变 SDK 地址、认证、模型或附加凭证', () => {
  const runtime = {
    ANTHROPIC_BASE_URL: 'https://old-gateway.invalid',
    ANTHROPIC_AUTH_TOKEN: 'old-token',
    ANTHROPIC_API_KEY: 'old-key',
    ANTHROPIC_CUSTOM_HEADERS: 'x-old-route: wrong',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
    DATABASE_URL: 'private-database',
    OPENAI_API_KEY: 'other-key',
    HTTP_PROXY: 'http://127.0.0.1:7890',
    PATH: '/test/bin',
  };
  const config = readDeepSeekConfig({
    DEEPSEEK_API_KEY: 'official-fixture',
    DEEPSEEK_REVIEW_MODEL: 'deepseek-v4-pro',
  });
  const options = createDeepSeekOptions(config, 'review', runtime);
  assert.equal(options.model, 'deepseek-v4-pro');
  assert.equal(options.env?.ANTHROPIC_BASE_URL, DEEPSEEK_BASE_URL);
  assert.equal(options.env?.ANTHROPIC_AUTH_TOKEN, 'official-fixture');
  assert.equal(options.env?.ANTHROPIC_DEFAULT_OPUS_MODEL, 'deepseek-v4-pro');
  assert.equal(options.env?.CLAUDE_CODE_SUBAGENT_MODEL, 'deepseek-v4-pro');
  assert.equal(options.env?.HTTP_PROXY, runtime.HTTP_PROXY);
  for (const key of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_CUSTOM_HEADERS',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
    'DATABASE_URL',
    'OPENAI_API_KEY',
  ]) {
    assert.equal(options.env?.[key], undefined, key);
  }
  assert.deepEqual(options.tools, []);
  assert.deepEqual(options.settingSources, []);
});
