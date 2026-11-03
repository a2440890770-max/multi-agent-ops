import assert from 'node:assert/strict';
import test from 'node:test';
import {
  estimateTokenCostMicrosCny,
  pricedModelReservation,
  pricedModelUsage,
  readExecutionPricing,
} from './execution-pricing.js';

const pricing = {
  version: 'test-cny-v1',
  inputMicrosCnyPerMillion: 2_000_000,
  outputMicrosCnyPerMillion: 8_000_000,
};
test('按配置的人民币单价以整数计价，预占及用量采用同一算法并保留原单价', () => {
  assert.equal(readExecutionPricing({}), undefined);
  assert.equal(estimateTokenCostMicrosCny(1000, 500, pricing), 6000);
  assert.equal(estimateTokenCostMicrosCny(1, 0, { ...pricing, inputMicrosCnyPerMillion: 1 }), 1);
  assert.equal(estimateTokenCostMicrosCny(0, 0, pricing), 0);
  const reservation = pricedModelReservation(2000, 1000, pricing);
  assert.equal(reservation.maxTokens, 3000);
  assert.equal(reservation.maxCostMicrosCny, 12000);
  assert.match(reservation.pricingRef, /test-cny-v1;input=2000000;output=8000000/);
  assert.deepEqual(pricedModelUsage(1000, 500, pricing), {
    usage: { tokens: 1500, estimatedCostMicrosCny: 6000 },
  });
});
test('缺少或错误的计价配置不能当作零费用，非法用量及溢出拒绝计价', () => {
  const env = {
    TASK_MODEL_PRICING_VERSION: pricing.version,
    TASK_MODEL_INPUT_MICROS_CNY_PER_MILLION: '2000000',
    TASK_MODEL_OUTPUT_MICROS_CNY_PER_MILLION: '8000000',
  };
  assert.deepEqual(readExecutionPricing(env), pricing);
  for (const change of [
    { TASK_MODEL_PRICING_VERSION: '' },
    { TASK_MODEL_INPUT_MICROS_CNY_PER_MILLION: '' },
    { TASK_MODEL_OUTPUT_MICROS_CNY_PER_MILLION: '-1' },
    { TASK_MODEL_OUTPUT_MICROS_CNY_PER_MILLION: '1.5' },
  ])
    assert.throws(() => readExecutionPricing({ ...env, ...change }));
  for (const value of [-1, 0.5, NaN, Infinity])
    assert.throws(() => estimateTokenCostMicrosCny(value, 0, pricing));
  assert.throws(() =>
    estimateTokenCostMicrosCny(1_000_000_000_000, 0, {
      ...pricing,
      inputMicrosCnyPerMillion: 1_000_000_000_000,
    }),
  );
  assert.throws(() => pricedModelReservation(0, 0, pricing));
});
