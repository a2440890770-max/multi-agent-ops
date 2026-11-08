import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { runContent, ContentError } from '../../agent/src/agents/content/index.ts';

// A standalone invocation, with no injected model transport or test fixtures.
const root = new URL('../../', import.meta.url);
const directory = new URL('./', import.meta.url);
const envPath = fileURLToPath(new URL('.env', root));
if (existsSync(envPath)) process.loadEnvFile(envPath);
const { values } = parseArgs({ options: { input: { type: 'string' } } });
const runId = randomUUID();
const startedAt = new Date().toISOString();
const evidenceFiles = [
  'README.md',
  'agent/src/agents/content/runtime.ts',
  'shared/src/schemas/content.ts',
  'frontend/src/pages/ManualEditorial.tsx',
];
const snapshots = await Promise.all(
  evidenceFiles.map(async (path) => {
    const content = (await readFile(new URL(path, root), 'utf8')).replace(/\r\n/g, '\n');
    return { path, sha256: createHash('sha256').update(content).digest('hex') };
  }),
);

// The default is an explicitly labelled local demonstration. It does not claim
// to be a persisted Research/Supervisor result or a real task execution.
const context = values.input
  ? JSON.parse(await readFile(values.input, 'utf8'))
  : {
      schemaVersion: '1.0',
      execution: {
        taskId: `local-demo-${runId}`,
        attemptId: `attempt-${runId}`,
        stepId: `content-${runId}`,
        inputSnapshotId: `input-${runId}`,
        epoch: 1,
      },
      controlMode: 'automatic',
      project: {
        id: 'local-multi-agent-ops',
        selectionId: `local-demo-selection-${runId}`,
        repository: 'a2440890770-max/multi-agent-ops',
        url: 'https://github.com/a2440890770-max/multi-agent-ops',
      },
      requirements: {
        revision: 1,
        objective:
          '用当前项目本地资料生成一份介绍 Multi-Agent Ops 的四页科普图文策划，说明设计目标、已有模块与仍待接入的部分。此为用户要求调用 Content 的独立演示，不是热榜入选结论或已完成的正式研究。',
        audience: '关注 AI 内容创作与运营协作的中文读者',
        tone: '自然、具体、克制，适合初次接触多 Agent 的读者',
        constraints: [
          '只使用本次本地资料，不添加外部事实。',
          '公开表达保留设计目标与当前实现的区别。',
          '没有实际运行项目或发布的证据，不声称已实现全自动运营、已经完成真实模型联调或已经发布。',
          '没有性能和竞品资料，不作效果与效率比较。',
        ],
        prohibitions: [
          '伪造热榜排名、性能指标、用户数量或商用许可',
          '把模拟执行描述为真实四 Agent 流程',
        ],
      },
      format: { pageCount: 4, titleMaxChars: 40, pageBodyMaxChars: 180 },
      research: {
        id: `local-demo-materials-${runId}`,
        projectId: 'local-multi-agent-ops',
        sources: [
          {
            id: 'source-readme',
            url: null,
            label: '用户工作区 README；本地一手资料，未经外部独立核验',
            locator: 'README.md：开头的项目定位与 Content 模块状态说明',
            excerpt:
              '内部团队的多 Agent 智能运营项目。当前第一阶段目标为 GitHub 热榜项目解读。真实任务执行、Research/Review、完整策划存储及人工接管/调整要求新执行尚待接入。',
          },
          {
            id: 'source-content-code',
            url: null,
            label: '已检查的本地 Content 源码；非真实模型联调结果',
            locator:
              'agent/src/agents/content/runtime.ts：runContent；shared/src/schemas/content.ts：ContentPlanSchema',
            excerpt:
              'runContent 是独立 SDK 入口，产出 title、cover、pages、caption、hashtags、projectUrl、productionNotes；模型调用有工具权限和结构化校验。',
          },
          {
            id: 'source-editorial-code',
            url: null,
            label: '已检查的本地人工编辑页面源码；非浏览器验收',
            locator:
              'frontend/src/pages/ManualEditorial.tsx：保存新版本、提交基础审核、批准当前版本、文案版本历史',
            excerpt:
              '页面提供人工编辑与保存新版本、基础审核、主观意见裁决，以及版本正文、对应审核和评分字段展示；基础规则检查不提供内容质量分数。',
          },
        ],
        facts: [
          {
            id: 'fact-goal',
            statement:
              '项目文档说明：项目面向 GitHub 项目解读，设计流程包含研究、图文策划、审核和人工处理。',
            kind: 'attributed_opinion',
            sourceIds: ['source-readme'],
            requiredQualifier: '项目文档说明',
          },
          {
            id: 'fact-content',
            statement:
              '当前源码提供独立的 Content 调用模块，交付标题、封面、逐页文案与画面建议、发布正文及来源映射。',
            kind: 'fact',
            sourceIds: ['source-content-code'],
            requiredQualifier: null,
          },
          {
            id: 'fact-editorial',
            statement:
              '当前页面源码提供人工编辑、保存文案版本、提交基础审核与主观意见裁决，并展示版本及其对应审核。',
            kind: 'fact',
            sourceIds: ['source-editorial-code'],
            requiredQualifier: null,
          },
          {
            id: 'fact-boundary',
            statement:
              '项目文档说明：真实任务执行、Research/Review 与完整图文策划存储仍待接入，不能将独立模块当成已上线的四 Agent 业务流程。',
            kind: 'attributed_opinion',
            sourceIds: ['source-readme'],
            requiredQualifier: '项目文档说明',
          },
        ],
        gaps: [],
        exclusions: [
          '不介绍热榜排名、项目效果、运行性能或许可结论。',
          '不将目标流程写成全部已经实现。',
        ],
      },
      usableFactIds: ['fact-goal', 'fact-content', 'fact-editorial', 'fact-boundary'],
      skill: { id: 'github-project-content', version: '1.0.0' },
      revision: { mode: 'initial', autoRevisionCount: 0 },
    };

await mkdir(directory, { recursive: true });
const prefix = `${startedAt.replace(/[:.]/g, '-')}-${runId}`;
const inputUrl = new URL(`${prefix}.input.json`, directory);
const reportUrl = new URL(`${prefix}.report.json`, directory);
const outputUrl = new URL(`${prefix}.output.json`, directory);
await writeFile(inputUrl, JSON.stringify(context, null, 2) + '\n', { flag: 'wx' });
const report = {
  runId,
  startedAt,
  inputOrigin: values.input ? 'explicit_input_file' : 'local_project_demonstration',
  scope:
    'Standalone Content invocation; no persisted Research/Supervisor acceptance, task write, review, approval or publication.',
  inputFile: fileURLToPath(inputUrl),
  sourceSnapshots: values.input ? [] : snapshots,
  passed: false,
  sdkStarted: false,
  events: [],
};
try {
  const result = await runContent(context, {
    query(request) {
      // Observe the real SDK transport. No fixture messages or substitute outputs.
      const debugCategories = new Set();
      const session = sdkQuery({
        ...request,
        options: {
          ...request.options,
          debug: true,
          stderr(chunk) {
            // Classify locally; never persist or forward raw SDK/provider logs.
            for (const [category, pattern] of [
              ['api_retry', /retrying|retry attempt/i],
              ['rate_limited', /rate.limit|\b429\b/i],
              [
                'invalid_parameter',
                /InvalidParameter|invalid_request_error|unsupported parameter/i,
              ],
              ['provider_timeout', /request timed out|ETIMEDOUT|socket hang up/i],
              ['network_error', /ENOTFOUND|ECONNREFUSED|fetch failed/i],
            ]) {
              if (!pattern.test(chunk) || debugCategories.has(category)) continue;
              debugCategories.add(category);
              report.transportDiagnostics = [...debugCategories];
              console.log(JSON.stringify({ event: 'sdk_diagnostic', category }));
            }
          },
        },
      });
      const observed = (async function* () {
        try {
          for await (const message of session) {
            if (message.type === 'assistant') {
              const blocks = message.message.content;
              const progress = {
                at: new Date().toISOString(),
                tools: blocks
                  .filter((block) => block.type === 'tool_use')
                  .map((block) =>
                    ['StructuredOutput', 'mcp__content__read_content_skill'].includes(block.name)
                      ? block.name
                      : '[other tool]',
                  ),
                textCharacters: blocks
                  .filter((block) => block.type === 'text')
                  .reduce((total, block) => total + block.text.length, 0),
                inputTokens: message.message.usage?.input_tokens ?? null,
                outputTokens: message.message.usage?.output_tokens ?? null,
              };
              report.modelProgress ??= [];
              report.modelProgress.push(progress);
              console.log(JSON.stringify({ event: 'model_turn', ...progress }));
            }
            if (message.type === 'result') {
              const summary = {
                subtype: message.subtype,
                isError: message.is_error,
                apiErrorStatus: message.api_error_status ?? null,
                turns: message.num_turns,
                sdkEstimatedCostUsd: message.total_cost_usd ?? null,
                modelUsage: Object.entries(message.modelUsage ?? {}).map(([model, usage]) => ({
                  model,
                  inputTokens: usage.inputTokens,
                  outputTokens: usage.outputTokens,
                })),
              };
              report.sdkResult = summary;
              console.log(JSON.stringify({ event: 'sdk_result', ...summary }));
            }
            yield message;
          }
        } catch (error) {
          report.transportError = {
            name: /^[a-zA-Z0-9_]{1,80}$/.test(error.name) ? error.name : 'Error',
            cancelled: Boolean(request.options.abortController?.signal.aborted),
          };
          console.log(JSON.stringify({ event: 'sdk_transport_error', ...report.transportError }));
          throw error;
        }
      })();
      return Object.assign(observed, { close: () => session.close() });
    },
    limits: {
      timeoutMs: 240_000,
      maxTurns: 8,
      maxBudgetUsd: 0.5,
      maxOutputTokens: 8192,
      maxOutputAttempts: 3,
    },
    onEvent(event) {
      report.events.push({ at: new Date().toISOString(), ...event });
      // 'started' records SDK dispatch, not confirmation that the provider received it.
      if (event.kind === 'started') report.sdkStarted = true;
      console.log(
        JSON.stringify({ event: event.kind, ...(event.code ? { code: event.code } : {}) }),
      );
    },
  });
  await writeFile(outputUrl, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  report.passed = true;
  report.decision = result.output.decision;
  report.outputFile = fileURLToPath(outputUrl);
  console.log(
    JSON.stringify({
      status: 'completed',
      decision: result.output.decision,
      outputFile: report.outputFile,
    }),
  );
} catch (error) {
  report.error = {
    code: error instanceof ContentError ? error.code : 'CONTENT_INVOCATION_FAILED',
    message: error instanceof ContentError ? error.message : '调用未完成；原始错误已省略。',
  };
  console.log(JSON.stringify({ status: 'failed', ...report.error, sdkStarted: report.sdkStarted }));
  process.exitCode = 1;
}
report.finishedAt = new Date().toISOString();
await writeFile(reportUrl, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(`Report: ${fileURLToPath(reportUrl)}`);
