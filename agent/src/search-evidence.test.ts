import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertSearchEvidence,
  extractSearchHits,
  officialSourceUrl,
  readOnlyDecision,
  normalizeSourceText,
} from './search-evidence.js';
import type { SearchAnswer, SearchEvidence } from './search-evidence.js';

const url = 'https://api-docs.deepseek.com/zh-cn/guides/anthropic_api';

test('Markdown 与 HTML 的显示格式不同不导致真实引用误判，虚假引用仍不能匹配', () => {
  const html =
    '<p><code>base_url</code> being <code>https://api.deepseek.com/anthropic</code></p><script>forged-hidden-quote</script>';
  const rendered = normalizeSourceText(html);
  assert.ok(
    rendered.includes(normalizeSourceText('`base_url` being `https://api.deepseek.com/anthropic`')),
  );
  assert.ok(
    !rendered.includes(normalizeSourceText('base_url being https://forged.invalid/anthropic')),
  );
  assert.ok(!rendered.includes('forged-hidden-quote'));
});
function empty(): SearchEvidence {
  return { searches: [], fetches: [], deniedTools: [] };
}
function completed(): SearchEvidence {
  return {
    ...empty(),
    searches: [
      {
        id: 'fixture-search',
        query: 'test',
        status: 'completed',
        hits: [{ title: 'Official docs', url, snippet: '' }],
      },
    ],
  };
}
const answer: SearchAnswer = {
  status: 'ok',
  summary: 'Test answer',
  anthropicBaseUrl: 'https://api.deepseek.com/anthropic',
  models: ['deepseek-flash'],
  sources: [{ title: 'Official docs', url, supportingText: 'deepseek-flash' }],
};

test('搜索验证拒绝命令、写入、文件读取及其他未开放工具', () => {
  for (const tool of ['Bash', 'Write', 'Edit', 'Read', 'Agent', 'mcp__unknown__tool']) {
    assert.ok(readOnlyDecision(tool, {}, empty(), false));
  }
  assert.equal(readOnlyDecision('WebSearch', { query: 'test' }, empty(), false), null);
  assert.equal(readOnlyDecision('StructuredOutput', {}, empty(), false), null);
});

test('读取工具仅可读取当前搜索实际返回的官方来源', () => {
  assert.ok(readOnlyDecision('WebFetch', { url }, empty(), false));
  assert.equal(readOnlyDecision('WebFetch', { url: url + '/' }, completed(), false), null);
  assert.ok(readOnlyDecision('WebFetch', { url: 'http://127.0.0.1/private' }, completed(), false));
});

test('负向测试禁止搜索后仍不允许来源读取或以记忆替代', () => {
  assert.ok(readOnlyDecision('WebSearch', { query: 'test' }, empty(), true));
  assert.ok(readOnlyDecision('WebFetch', { url }, empty(), true));
  assert.throws(() => assertSearchEvidence(answer, empty()), /没有真实成功/);
});

test('只接受工具的结构化搜索条目，不从模型评论中提取网址', () => {
  assert.deepEqual(extractSearchHits({ results: [`A claimed source: ${url}`] }), []);
  const hits = extractSearchHits({
    results: [
      {
        tool_use_id: 'fixture-server-search',
        content: [
          { title: 'Official docs', url: url + '/', snippet: 'Test' },
          { title: 'Other', url: 'https://untrusted.invalid' },
        ],
      },
    ],
  });
  assert.deepEqual(hits, [{ title: 'Official docs', url, snippet: 'Test' }]);
});

test('有 SDK 结果或网址但没有成功搜索时不能通过', () => {
  const evidence = empty();
  evidence.searches.push({ id: 'failed', query: 'test', status: 'failed', hits: [] });
  assert.throws(() => assertSearchEvidence(answer, evidence), /没有真实成功/);
});

test('模型引用不在搜索结果中的链接时拒绝验收', () => {
  assert.doesNotThrow(() => assertSearchEvidence(answer, completed()));
  assert.throws(
    () =>
      assertSearchEvidence(
        {
          ...answer,
          sources: [{ ...answer.sources[0]!, url: 'https://api-docs.deepseek.com/not-returned' }],
        },
        completed(),
      ),
    /没有返回的链接/,
  );
});

test('来源域名策略拒绝伪装域名、明文 HTTP、认证信息和非标准端口', () => {
  for (const invalid of [
    'http://api-docs.deepseek.com',
    'https://api-docs.deepseek.com.evil.invalid',
    'https://user:password@api-docs.deepseek.com',
    'https://api-docs.deepseek.com:8443',
  ]) {
    assert.throws(() => officialSourceUrl(invalid));
  }
});
