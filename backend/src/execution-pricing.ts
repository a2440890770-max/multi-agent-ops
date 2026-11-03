import type { CallReservation, StepResult } from './execution-control.js';

export interface ExecutionPricing {
  version: string;
  inputMicrosCnyPerMillion: number;
  outputMicrosCnyPerMillion: number;
}
const quantity = (value: number) =>
  Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000_000;

/** No live prices or implicit USD/CNY conversion. Operators configure a versioned CNY tariff. */
export function readExecutionPricing(
  env: Record<string, string | undefined>,
): ExecutionPricing | undefined {
  const version = env.TASK_MODEL_PRICING_VERSION?.trim();
  const input = env.TASK_MODEL_INPUT_MICROS_CNY_PER_MILLION?.trim();
  const output = env.TASK_MODEL_OUTPUT_MICROS_CNY_PER_MILLION?.trim();
  if (!version && !input && !output) return;
  if (
    !version ||
    !/^[A-Za-z0-9_.-]{1,64}$/.test(version) ||
    !input ||
    !output ||
    !/^\d+$/.test(input) ||
    !/^\d+$/.test(output) ||
    !quantity(Number(input)) ||
    !quantity(Number(output))
  )
    throw new Error(
      '模型计价必须同时配置版本及有效的输入/输出人民币单价，单位为每百万Token的百万分之一元。',
    );
  return {
    version,
    inputMicrosCnyPerMillion: Number(input),
    outputMicrosCnyPerMillion: Number(output),
  };
}
export function estimateTokenCostMicrosCny(
  inputTokens: number,
  outputTokens: number,
  pricing: ExecutionPricing,
) {
  if (
    ![
      inputTokens,
      outputTokens,
      pricing.inputMicrosCnyPerMillion,
      pricing.outputMicrosCnyPerMillion,
    ].every(quantity)
  )
    throw new Error('计价用量及单价必须为范围内的非负整数。');
  const amount =
    (BigInt(inputTokens) * BigInt(pricing.inputMicrosCnyPerMillion) +
      BigInt(outputTokens) * BigInt(pricing.outputMicrosCnyPerMillion) +
      999_999n) /
    1_000_000n;
  if (amount > 1_000_000_000_000n) throw new Error('单次调用估算费用超出支持范围。');
  return Number(amount);
}
export function pricedModelReservation(
  maxInputTokens: number,
  maxOutputTokens: number,
  pricing: ExecutionPricing,
): CallReservation {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(pricing.version)) throw new Error('模型计价版本无效。');
  const maxCostMicrosCny = estimateTokenCostMicrosCny(maxInputTokens, maxOutputTokens, pricing);
  if (!quantity(maxInputTokens + maxOutputTokens) || maxInputTokens + maxOutputTokens < 1)
    throw new Error('模型调用必须声明有效的Token上界。');
  return {
    kind: 'model',
    maxTokens: maxInputTokens + maxOutputTokens,
    maxCostMicrosCny,
    // Keep the actual tariff with each immutable call, even if deployment config changes.
    pricingRef: `${pricing.version};input=${pricing.inputMicrosCnyPerMillion};output=${pricing.outputMicrosCnyPerMillion};unit=microCNY/1M`,
  };
}
export function pricedModelUsage(
  inputTokens: number,
  outputTokens: number,
  pricing: ExecutionPricing,
): StepResult {
  const estimatedCostMicrosCny = estimateTokenCostMicrosCny(inputTokens, outputTokens, pricing);
  if (!quantity(inputTokens + outputTokens)) throw new Error('模型返回的Token合计无效。');
  return { usage: { tokens: inputTokens + outputTokens, estimatedCostMicrosCny } };
}
