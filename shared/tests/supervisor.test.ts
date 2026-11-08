import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import {
  SupervisorContextSchema,
  SupervisorOutputSchema,
  type SupervisorContext,
  type SupervisorOutput,
} from '../src/index.js';

const context: SupervisorContext = {
  schemaVersion: '1.0',
  execution: {
    taskId: 'task-1',
    attemptId: 'attempt-1',
    stepId: 'step-1',
    inputSnapshotId: 'snapshot-1',
  },
  trigger: 'task_started',
  task: { title: '活动预告', originalRequest: '研究活动信息，准备一条微博。', referenceInputs: [] },
  clarifications: [],
  accountContext: {
    accountId: null,
    description: null,
    defaultAudience: null,
    defaultTone: null,
    prohibitions: [],
  },
  memoryContext: [],
  researchContext: {
    authorizationId: 'authorization-1',
    authorizationUsed: false,
    acceptedResultIds: [],
  },
  runtimePolicy: {
    stage: 'D9',
    allowedSubagents: ['research'],
    configVersion: 1,
    promptVersion: 'supervisor-v1',
    toolPolicyVersion: 'tools-v1',
  },
  contextSelection: { includedRefs: [], omitted: [] },
};

const common = {
  summary: '已检查任务要求和研究依据。',
  basisRefs: [],
  defaultsUsed: [],
  warnings: [],
};
const clarification: SupervisorOutput = {
  ...common,
  decision: 'needs_clarification',
  questions: [
    {
      kind: 'conflicting_requirements',
      question: '活动日期以哪一项要求为准？',
      reason: '日期冲突。',
    },
  ],
};
const materials: SupervisorOutput = {
  ...common,
  decision: 'needs_materials',
  researchResultId: 'research-1',
  blockingGaps: [
    {
      researchGapId: 'gap-1',
      impact: '无法确定活动日期。',
      requestedMaterial: '请提供官方活动通知。',
    },
  ],
};
const ready: SupervisorOutput = {
  ...common,
  decision: 'ready_for_content',
  researchResultId: 'research-1',
  contentBrief: {
    topic: '活动预告',
    objective: '介绍已经核实的活动信息。',
    constraints: [],
    usableFactIds: ['fact-1'],
    exclusions: [
      { researchGapId: 'gap-2', omittedClaim: '行业排名第一', reason: '非关键说法且无可靠证据。' },
    ],
  },
};

test('输入允许无账号、无记忆及空资料列表，保留未答问题和原始文本', () => {
  const value = {
    ...context,
    task: { ...context.task, originalRequest: '  保留用户原始要求。\n' },
    clarifications: [{ questionId: 'question-1', question: '活动日期是哪天？', answer: null }],
  };
  assert.deepEqual(SupervisorContextSchema.parse(value), value);
});

test('D9 输入拒绝权限扩展、未定义字段、缺失字段和非法版本', () => {
  const missingVersion = { ...context };
  Reflect.deleteProperty(missingVersion, 'schemaVersion');
  for (const value of [
    missingVersion,
    { ...context, schemaVersion: '2.0' },
    { ...context, apiKey: 'unexpected-secret' },
    {
      ...context,
      runtimePolicy: { ...context.runtimePolicy, allowedSubagents: ['general-purpose'] },
    },
    { ...context, runtimePolicy: { ...context.runtimePolicy, tools: ['WebSearch'] } },
    { ...context, runtimePolicy: { ...context.runtimePolicy, configVersion: 0 } },
    { ...context, accountContext: { ...context.accountContext, accountId: undefined } },
    { ...context, clarifications: [{ questionId: 'q-1', question: '日期？', answer: ' \n' }] },
  ]) {
    assert.equal(SupervisorContextSchema.safeParse(value).success, false);
  }
});

test('三种最终决定均可用，不把研究完成等同于内容产出或发布批准', () => {
  for (const value of [clarification, materials, ready]) {
    assert.deepEqual(SupervisorOutputSchema.parse(value), value);
  }
  for (const decision of ['dispatch_research', 'approved', 'published', 'failed']) {
    assert.equal(SupervisorOutputSchema.safeParse({ ...ready, decision }).success, false);
  }
});

test('拒绝无实际问题的等待、空白交接及混合分支', () => {
  const missingResult = { ...ready };
  Reflect.deleteProperty(missingResult, 'researchResultId');
  for (const value of [
    { ...clarification, questions: [] },
    { ...materials, blockingGaps: [] },
    { ...ready, summary: '\n\t ' },
    { ...ready, researchResultId: ' ' },
    { ...ready, contentBrief: { ...ready.contentBrief, objective: ' ' } },
    { ...ready, contentBrief: { ...ready.contentBrief, usableFactIds: [''] } },
    { ...ready, questions: clarification.questions },
    { ...clarification, contentBrief: ready.contentBrief },
    missingResult,
    JSON.stringify(ready),
  ]) {
    assert.equal(SupervisorOutputSchema.safeParse(value).success, false);
  }
});

test('拒绝未定义的嵌套权限字段和模型伪造的执行元数据', () => {
  for (const value of [
    { ...ready, taskId: 'other-task' },
    { ...ready, approvalId: 'fake-approval' },
    { ...ready, defaultsUsed: [{ field: 'price', value: '9.9', basis: 'reasonable_default' }] },
    {
      ...ready,
      warnings: [{ code: 'GAP', message: '证据不足', relatedRefs: [], tools: ['Bash'] }],
    },
    { ...ready, contentBrief: { ...ready.contentBrief, approved: true } },
  ]) {
    assert.equal(SupervisorOutputSchema.safeParse(value).success, false);
  }
});

test('契约可以导出为 draft-7 JSON Schema，保留严格对象和分支约束', () => {
  const inputSchema = z.toJSONSchema(SupervisorContextSchema, { target: 'draft-7' });
  const outputSchema = z.toJSONSchema(SupervisorOutputSchema, { target: 'draft-7' });
  assert.equal(inputSchema.additionalProperties, false);
  assert.equal(inputSchema.properties?.schemaVersion?.const, '1.0');
  assert.equal(outputSchema.oneOf?.length, 3);
  for (const branch of outputSchema.oneOf ?? []) {
    assert.equal(typeof branch, 'object');
    if (typeof branch !== 'object') continue;
    assert.equal(branch.additionalProperties, false);
    assert.ok(branch.required?.includes('decision'));
  }
  assert.doesNotThrow(() => JSON.stringify({ inputSchema, outputSchema }));
});
