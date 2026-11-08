import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { createDeepSeekOptions, DEEPSEEK_BASE_URL, readDeepSeekConfig } from './model-config.js';

export class ContentModelConfigError extends Error {}

const bailianModels = ['deepseek-v4.1-flash', 'deepseek-v4.1-flash-1017', 'deepseek-v4-pro'];
const regionalHosts = new Set([
  'dashscope.aliyuncs.com',
  'dashscope-intl.aliyuncs.com',
  'dashscope-us.aliyuncs.com',
  // Explicitly supplied by the user for this deployment, not discovered from model output.
  'cn-beijing.maas.qianwenaiapi.com',
]);

export function bailianAnthropicUrl(value: string | undefined): string {
  if (!value?.trim())
    throw new ContentModelConfigError('缺少 BAILIAN_BASE_URL，请填写密钥对应的调用地址。');
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ContentModelConfigError('BAILIAN_BASE_URL 不是有效地址。');
  }
  const workspaceHost =
    /^[a-z0-9-]+\.(cn-beijing|ap-southeast-1|eu-central-1|ap-northeast-1)\.maas\.aliyuncs\.com$/;
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    (!regionalHosts.has(url.hostname) && !workspaceHost.test(url.hostname))
  )
    throw new ContentModelConfigError('百炼地址不在当前部署允许的 HTTPS 服务范围内。');
  const path = url.pathname.replace(/\/$/, '');
  if (!['', '/apps/anthropic', '/compatible-mode/v1'].includes(path))
    throw new ContentModelConfigError(
      '百炼地址须为 API Host、OpenAI 兼容 Base URL 或 Anthropic 兼容 Base URL。',
    );
  return `${url.origin}/apps/anthropic`;
}

/** Explicit provider selection; credentials never fall back across providers. */
export function createContentModelOptions(env: NodeJS.ProcessEnv): {
  options: Options;
  provider: 'deepseek' | 'bailian';
  baseUrl: string;
} {
  const provider = env.CONTENT_MODEL_PROVIDER?.trim() || 'deepseek';
  if (provider === 'deepseek')
    return {
      options: createDeepSeekOptions(readDeepSeekConfig(env), 'primary', env),
      provider,
      baseUrl: DEEPSEEK_BASE_URL,
    };
  if (provider !== 'bailian')
    throw new ContentModelConfigError('CONTENT_MODEL_PROVIDER 必须为 deepseek 或 bailian。');
  const apiKey = env.DASHSCOPE_API_KEY?.trim();
  if (!apiKey)
    throw new ContentModelConfigError('百炼模式缺少 DASHSCOPE_API_KEY，不会复用其他提供商的密钥。');
  const model = env.BAILIAN_MODEL?.trim() || 'deepseek-v4.1-flash';
  if (!bailianModels.includes(model))
    throw new ContentModelConfigError('BAILIAN_MODEL 不在已核对的百炼 DeepSeek 模型列表中。');
  const baseUrl = bailianAnthropicUrl(env.BAILIAN_BASE_URL);
  // Reuse the SDK transport configuration and its environment allowlist.
  const options = createDeepSeekOptions({ apiKey, model, reviewModel: model }, 'primary', env);
  options.env = { ...options.env, ANTHROPIC_BASE_URL: baseUrl };
  return { options, provider, baseUrl };
}
