import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SelectProjectAndAuthorizeResearchSchema,
  SubmitMaterialsAndAuthorizeResearchSchema,
  normalizeResearchSiteGrant,
} from '../src/index.js';

const attemptId = '11111111-1111-4111-8111-111111111111';
const supplement = () => ({
  expectedRevision: 1,
  attemptId,
  baseResultId: 'r-1',
  questionIds: ['q-1'],
  gapIds: [],
  materials: [],
  confirmExistingMaterials: [],
  officialSiteGrants: [],
  authorizeResearch: true,
});

test('研究命令需要明确授权；正文不能伪造操作者、执行权或新问题', () => {
  const select = {
    expectedRevision: 1,
    attemptId,
    hotListSnapshotId: attemptId,
    candidateId: 'candidate-1',
    authorizeResearch: true,
  };
  assert.ok(SelectProjectAndAuthorizeResearchSchema.safeParse(select).success);
  for (const extra of [
    { authorizeResearch: false },
    { authorizedBy: 'other' },
    { lease: {} },
    { newQuestions: [] },
  ]) {
    assert.equal(
      SelectProjectAndAuthorizeResearchSchema.safeParse({ ...select, ...extra }).success,
      false,
    );
    assert.equal(
      SubmitMaterialsAndAuthorizeResearchSchema.safeParse({ ...supplement(), ...extra }).success,
      false,
    );
  }
});

test('无新资料可补查，但问题不能为空或重复；仅链接不能确认一手正文', () => {
  assert.ok(SubmitMaterialsAndAuthorizeResearchSchema.safeParse(supplement()).success);
  for (const questionIds of [[], ['q-1', 'q-1']])
    assert.equal(
      SubmitMaterialsAndAuthorizeResearchSchema.safeParse({ ...supplement(), questionIds }).success,
      false,
    );
  const material = {
    clientRef: 'm-1',
    label: '用户资料',
    text: null,
    sourceUrl: 'https://example.com/docs/',
    confirmFirstHand: false,
  };
  assert.ok(
    SubmitMaterialsAndAuthorizeResearchSchema.safeParse({ ...supplement(), materials: [material] })
      .success,
  );
  assert.equal(
    SubmitMaterialsAndAuthorizeResearchSchema.safeParse({
      ...supplement(),
      materials: [{ ...material, confirmFirstHand: true }],
    }).success,
    false,
  );
  assert.equal(
    SubmitMaterialsAndAuthorizeResearchSchema.safeParse({
      ...supplement(),
      materials: [{ ...material, sourceUrl: null }],
    }).success,
    false,
  );
  assert.equal(
    SubmitMaterialsAndAuthorizeResearchSchema.safeParse({
      ...supplement(),
      materials: [material, material],
    }).success,
    false,
  );
});

test('官网授权只接受明确 origin 和无编码歧义的路径，不能隐含新站点', () => {
  assert.deepEqual(
    normalizeResearchSiteGrant({ origin: 'https://EXAMPLE.com:443/', pathPrefix: '/docs/' }),
    { origin: 'https://example.com', pathPrefix: '/docs/' },
  );
  for (const origin of [
    'http://example.com',
    'https://user:password@example.com',
    'https://127.0.0.1',
    'https://localhost',
    'https://example.com/blog/',
    'https://example.com:444',
    'https://example.com?x=1',
  ])
    assert.throws(() => normalizeResearchSiteGrant({ origin, pathPrefix: '/docs/' }));
  for (const pathPrefix of [
    '//evil.example/path',
    '/docs/../blog/',
    '/docs/%2e%2e/blog/',
    '/docs/%252f',
    '/docs/%2fblog',
    '/docs\\blog',
    '/docs/?path=/blog',
  ])
    assert.throws(() => normalizeResearchSiteGrant({ origin: 'https://example.com', pathPrefix }));
});

test('资料正文原样保留，传输长度与一次提交总量有限', () => {
  const material = {
    clientRef: 'm-1',
    label: '说明',
    text: '  一手说明\r\n保留原文。\n',
    sourceUrl: null,
    confirmFirstHand: true,
  };
  assert.equal(
    SubmitMaterialsAndAuthorizeResearchSchema.parse({ ...supplement(), materials: [material] })
      .materials[0]?.text,
    material.text,
  );
  assert.equal(
    SubmitMaterialsAndAuthorizeResearchSchema.safeParse({
      ...supplement(),
      materials: Array.from({ length: 6 }, (_, i) => ({
        ...material,
        clientRef: `m-${i}`,
        text: '字'.repeat(20_000),
      })),
    }).success,
    false,
  );
});
