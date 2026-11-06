import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchGithubHot, GithubHotError, GITHUB_HOT_API_URL } from './index.js';

const env = { XXAPI_ACCESS_KEY: 'offline-fixture-key' };
const errorCode = (code: string) => (error: unknown) =>
  error instanceof GithubHotError && error.code === code;

test('GitHub 热榜以固定地址和 Bearer 头请求，原样保留成功标记 1', async () => {
  let calls = 0;
  const result = await fetchGithubHot({
    env,
    fetch: async (url, options) => {
      calls += 1;
      assert.equal(url, GITHUB_HOT_API_URL);
      assert.equal(options?.method, 'GET');
      assert.equal(options?.redirect, 'error');
      const headers = new Headers(options?.headers);
      assert.equal(headers.get('Authorization'), `Bearer ${env.XXAPI_ACCESS_KEY}`);
      assert.equal(headers.get('Accept'), 'application/json');
      return Response.json(1);
    },
  });
  assert.equal(result.provider, 'xxapi');
  assert.equal(result.data, 1);
  assert.equal(Number.isNaN(Date.parse(result.fetchedAt)), false);
  assert.equal(JSON.stringify(result).includes(env.XXAPI_ACCESS_KEY), false);
  assert.equal(calls, 1);
});

test('未知返回结构保持原样，不臆造榜单、名次、时间窗口或 Star 指标', async () => {
  const payload = { providerSpecificField: [{ anything: 'offline fixture' }] };
  const result = await fetchGithubHot({ env, fetch: async () => Response.json(payload) });
  assert.deepEqual(result.data, payload);
});

test('缺少密钥、非法头内容或无界超时时不发起网络请求', async () => {
  let calls = 0;
  const transport: typeof fetch = async () => {
    calls += 1;
    return Response.json(1);
  };
  await assert.rejects(
    fetchGithubHot({ env: {}, fetch: transport }),
    errorCode('XXAPI_KEY_MISSING'),
  );
  for (const options of [
    { env: { XXAPI_ACCESS_KEY: 'key\r\nOther: value' } },
    { env, timeoutMs: 0 },
    { env, timeoutMs: Number.POSITIVE_INFINITY },
    { env, timeoutMs: 120_001 },
  ]) {
    await assert.rejects(
      fetchGithubHot({ ...options, fetch: transport }),
      errorCode('XXAPI_CONFIGURATION_INVALID'),
    );
  }
  assert.equal(calls, 0);
});

test('HTTP 错误不重试、不返回供应商错误正文或密钥', async () => {
  let calls = 0;
  await assert.rejects(
    fetchGithubHot({
      env,
      fetch: async () => {
        calls += 1;
        return new Response(`private-provider-body ${env.XXAPI_ACCESS_KEY}`, { status: 401 });
      },
    }),
    (error: unknown) =>
      error instanceof GithubHotError &&
      error.httpStatus === 401 &&
      !error.message.includes(env.XXAPI_ACCESS_KEY) &&
      !error.message.includes('private-provider-body'),
  );
  assert.equal(calls, 1);
});

test('网络错误和非 JSON 响应使用安全错误码', async () => {
  await assert.rejects(
    fetchGithubHot({
      env,
      fetch: async () => {
        throw new Error(`request Authorization: Bearer ${env.XXAPI_ACCESS_KEY}`);
      },
    }),
    (error: unknown) =>
      error instanceof GithubHotError &&
      error.code === 'XXAPI_NETWORK_ERROR' &&
      !error.message.includes(env.XXAPI_ACCESS_KEY),
  );
  await assert.rejects(
    fetchGithubHot({ env, fetch: async () => new Response('<html>error</html>') }),
    errorCode('XXAPI_INVALID_JSON'),
  );
});

test('调用前取消不发请求，运行中取消和超时不采用迟到结果', async () => {
  const aborted = new AbortController();
  aborted.abort();
  let calls = 0;
  const transport: typeof fetch = async () => {
    calls += 1;
    return Response.json(1);
  };
  await assert.rejects(
    fetchGithubHot({ env, signal: aborted.signal, fetch: transport }),
    errorCode('XXAPI_CANCELLED'),
  );
  assert.equal(calls, 0);

  const slow: typeof fetch = async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return Response.json(1);
  };
  await assert.rejects(
    fetchGithubHot({ env, timeoutMs: 5, fetch: slow }),
    errorCode('XXAPI_TIMEOUT'),
  );
  const controller = new AbortController();
  const pending = fetchGithubHot({ env, signal: controller.signal, fetch: slow });
  controller.abort();
  await assert.rejects(pending, errorCode('XXAPI_CANCELLED'));
});
