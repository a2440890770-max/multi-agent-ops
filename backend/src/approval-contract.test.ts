import assert from 'node:assert/strict';
import test from 'node:test';
import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';
import type { ApiSuccess, Approval, TaskDetail } from '@multi-agent-ops/shared';
import { createApp } from './app.js';

const timestamp = '2026-10-28T06:00:00.000Z';
const approval: Approval = {
  id: 'approval-1',
  taskId: 'task-1',
  contentVersionId: 'version-1',
  contentHash: 'a'.repeat(64),
  accountId: 'account-1',
  reviewCycleId: 'review-1',
  status: 'approved',
  approvedBy: 'member-1',
  approvedAt: timestamp,
  invalidatedAt: null,
  invalidatedReason: null,
};
const unavailable = { allowed: false, reason: 'Wire-contract fixture' };
const task: TaskDetail = {
  task: {
    id: 'task-1',
    teamId: 'team-1',
    accountId: 'account-1',
    title: '批准响应契约样例',
    originalRequest: '生成一条文案',
    referenceInputs: [],
    clarifications: [],
    lifecycle: 'open',
    revision: 2,
    currentAttemptId: null,
    currentContentVersionId: 'version-1',
    currentReviewCycleId: 'review-1',
    currentApprovalId: approval.id,
    activePublishOperationId: null,
    publishedOperationId: null,
    sourceTaskId: null,
    createdBy: 'member-1',
    createdAt: timestamp,
    updatedAt: timestamp,
    terminatedBy: null,
    terminatedAt: null,
    terminationReason: null,
  },
  execution: null,
  approval: 'approved',
  publication: 'not_published',
  reflection: 'not_triggered',
  currentStep: null,
  currentAttempt: null,
  currentContent: {
    id: 'version-1',
    taskId: 'task-1',
    originAttemptId: null,
    parentVersionId: null,
    versionNo: 1,
    body: '已审核的文案',
    contentHash: approval.contentHash,
    sourceKind: 'manual',
    revisionRoundId: null,
    sourceRefs: [],
    usedMemoryRefs: [],
    createdBy: 'member-1',
    createdAt: timestamp,
  },
  currentReview: {
    id: 'review-1',
    taskId: 'task-1',
    attemptId: null,
    trigger: 'manual_submit',
    inputVersionId: 'version-1',
    currentVersionId: 'version-1',
    status: 'completed',
    records: [],
    requestedBy: 'member-1',
    configVersion: 1,
    createdAt: timestamp,
    finishedAt: timestamp,
    error: null,
  },
  currentApproval: approval,
  currentPublication: null,
  latestReflection: null,
  errorMessage: null,
  workLock: null,
  actions: {
    save: unavailable,
    start: unavailable,
    stop: unavailable,
    terminate: unavailable,
    retry: unavailable,
    copy: unavailable,
    review: unavailable,
    approve: unavailable,
    publish: unavailable,
    backfill: unavailable,
    verify: unavailable,
    retry_publish: unavailable,
    reflect: unavailable,
  },
  account: {
    id: 'account-1',
    displayName: '测试账号',
    platform: 'weibo',
    authorizationStatus: 'unconfigured',
    officialPublishAvailable: false,
  },
};
// Keep the fixture independent of the response-model key and generator's naming scheme.
const success: ApiSuccess<{ approval: Approval; task: TaskDetail }> = {
  data: { approval, task },
  meta: { requestId: 'contract-regression', replayed: false },
};

type Operation = {
  responses: Record<string, { content: Record<string, { schema: AnySchema }> }>;
};
type PublishedSpec = {
  components: { schemas: Record<string, AnySchema> };
  paths: Record<string, { post: Operation }>;
};
async function publishedSpec(): Promise<PublishedSpec> {
  const app = createApp({
    checkDatabase: async () => {
      throw new Error('Contract tests must not access a database');
    },
    checkAgent: async () => {
      throw new Error('Contract tests must not call an Agent');
    },
  });
  try {
    const response = await app.inject('/api/v1/openapi.json');
    assert.equal(response.statusCode, 200);
    return response.json<PublishedSpec>();
  } finally {
    await app.close();
  }
}
function validator(spec: PublishedSpec, schema: AnySchema) {
  return new Ajv2020({ strict: false, allErrors: true }).compile({
    components: spec.components,
    ...(schema as Record<string, unknown>),
  });
}

test('published approval 200/201 schemas accept a typed success response with a non-null current approval', async () => {
  const spec = await publishedSpec();
  const operation = spec.paths['/api/v1/tasks/{taskId}/approvals']!.post;
  for (const status of ['200', '201']) {
    const validate = validator(
      spec,
      operation.responses[status]!.content['application/json']!.schema,
    );
    assert.equal(validate(success), true, `${status}: ${JSON.stringify(validate.errors)}`);
  }
});

test('published approval success schemas reject missing record fields, invalid status and nested response wrappers', async () => {
  const spec = await publishedSpec();
  const schema =
    spec.paths['/api/v1/tasks/{taskId}/approvals']!.post.responses['201']!.content[
      'application/json'
    ]!.schema;
  const validate = validator(spec, schema);
  const { id: omitted, ...missingId } = approval;
  assert.equal(omitted, 'approval-1');
  for (const invalid of [missingId, { ...approval, status: 'published' }, { approval, task }])
    assert.equal(validate({ ...success, data: { ...success.data, approval: invalid } }), false);
});

test('the published standalone Approval schema describes a domain record rather than its response wrapper', async () => {
  const spec = await publishedSpec();
  const validate = validator(spec, { $ref: '#/components/schemas/Approval' });
  assert.equal(validate(approval), true, JSON.stringify(validate.errors));
  assert.equal(validate(success.data), false);
});
