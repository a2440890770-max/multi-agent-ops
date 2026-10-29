export interface AuthConfig {
  secret: Buffer;
  trustedOrigins: string[];
  secureCookie: boolean;
}

export function readAuthConfig(env: NodeJS.ProcessEnv): AuthConfig | undefined {
  if (!env.AUTH_SECRET) {
    if (env.NODE_ENV === 'production') throw new Error('生产认证服务需要 AUTH_SECRET。');
    return undefined;
  }
  if (!/^[a-fA-F0-9]{64}$/.test(env.AUTH_SECRET))
    throw new Error('AUTH_SECRET 必须为 32 字节随机值的 64 位十六进制编码。');
  const secureCookie = env.NODE_ENV === 'production';
  if (secureCookie && !env.AUTH_TRUSTED_ORIGINS)
    throw new Error('生产认证服务需要明确配置 HTTPS AUTH_TRUSTED_ORIGINS。');
  const trustedOrigins = (
    env.AUTH_TRUSTED_ORIGINS ??
    'http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:3001,http://localhost:3001'
  )
    .split(',')
    .map((origin) => origin.trim());
  for (const origin of trustedOrigins) {
    const url = new URL(origin);
    const localHttp =
      !secureCookie &&
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.origin !== origin || (url.protocol !== 'https:' && !localHttp))
      throw new Error('可信来源须为完整 HTTPS Origin；本机开发允许 localhost HTTP Origin。');
  }
  return { secret: Buffer.from(env.AUTH_SECRET, 'hex'), trustedOrigins, secureCookie };
}
