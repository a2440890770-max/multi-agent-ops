import type { Options } from '@anthropic-ai/claude-agent-sdk';

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/anthropic';
export const DEFAULT_MODEL = 'deepseek-flash';
export type ModelRole = 'primary' | 'review';
export type DeepSeekConfig = {
  apiKey: string;
  model: string;
  reviewModel: string;
};

function readModel(value: string | undefined): string {
  const model = value?.trim() || DEFAULT_MODEL;
  if (!['deepseek-flash', 'deepseek-v4-pro'].includes(model)) {
    throw new Error(
      '模型必须为 deepseek-flash 或 deepseek-v4-pro；不接受中转站或 Claude 模型别名。',
    );
  }
  return model;
}

export function readDeepSeekConfig(env: NodeJS.ProcessEnv = process.env): DeepSeekConfig {
  const apiKey = env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) throw new Error('缺少 DEEPSEEK_API_KEY；尚未发起模型调用。');
  return {
    apiKey,
    model: readModel(env.DEEPSEEK_MODEL),
    reviewModel: readModel(env.DEEPSEEK_REVIEW_MODEL),
  };
}

// Only runtime/network variables cross into the SDK child process. Provider overrides,
// old gateway headers, database credentials and unrelated API keys are not inherited.
const runtimeVariables = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_USE_ENV_PROXY',
];

export function createDeepSeekOptions(
  config: DeepSeekConfig,
  role: ModelRole = 'primary',
  runtimeEnv: NodeJS.ProcessEnv = process.env,
): Options {
  const model = role === 'review' ? config.reviewModel : config.model;
  const env: NodeJS.ProcessEnv = {};
  for (const name of runtimeVariables) {
    if (runtimeEnv[name] !== undefined) env[name] = runtimeEnv[name];
  }
  Object.assign(env, {
    ANTHROPIC_BASE_URL: DEEPSEEK_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: config.apiKey,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_DEFAULT_FABLE_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '1024',
    API_TIMEOUT_MS: '45000',
  });
  return {
    model,
    env,
    tools: [],
    skills: [],
    settingSources: [],
    mcpServers: {},
    strictMcpConfig: true,
    plugins: [],
    permissionMode: 'dontAsk',
    persistSession: false,
    thinking: { type: 'disabled' },
  };
}
