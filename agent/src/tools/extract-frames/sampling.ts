import type { ExtractFramesInput } from '@multi-agent-ops/shared';
import type { VideoAsset } from '../fetch-video/types.js';
import { FramesError, type ExtractFramesConfig } from './types.js';

export interface SamplingPlan {
  mode: 'uniform' | 'timestamps';
  times: number[];
}
export interface Candidate {
  index: number;
  pts: number;
  time: number;
  width: number;
  height: number;
  sar: number;
}
export const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export function numeric(value: unknown): number | null {
  if ((typeof value !== 'string' && typeof value !== 'number') || value === '') return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}
export function ratio(value: unknown): [number, number] | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d+)[/:](\d+)$/.exec(value);
  if (!match) return null;
  const numerator = Number(match[1]),
    denominator = Number(match[2]);
  return Number.isSafeInteger(numerator) &&
    Number.isSafeInteger(denominator) &&
    numerator > 0 &&
    denominator > 0
    ? [numerator, denominator]
    : null;
}
export function createSamplingPlan(
  input: ExtractFramesInput,
  video: VideoAsset,
  config: ExtractFramesConfig,
): SamplingPlan {
  const count = input.timestampsSeconds?.length ?? input.count ?? config.defaultCount;
  if (count > config.maxFrames)
    throw new FramesError('INVALID_INPUT', '请求帧数超过后端上限；未截断请求。');
  const duration = video.result.durationSeconds;
  if (input.timestampsSeconds) {
    if (input.timestampsSeconds.some((time) => time >= duration))
      throw new FramesError('INVALID_INPUT', '采样时间点超出视频范围；未自动修改时间。');
    return { mode: 'timestamps', times: [...input.timestampsSeconds] };
  }
  return {
    mode: 'uniform',
    times: Array.from({ length: count }, (_, index) => ((index + 0.5) * duration) / count),
  };
}

/** Keep only one nearest decoded frame per request; do not buffer the full frame listing. */
export function createFrameSelector(
  plan: SamplingPlan,
  context: { start: number; timeBase: [number, number]; duration: number; sar: number },
) {
  const selected: (Candidate | null)[] = plan.times.map(() => null);
  let index = 0;
  let lastPts: number | null = null;
  return {
    selected,
    observe(line: string) {
      if (!line.trim()) return;
      const fields = Object.fromEntries(
        line
          .trim()
          .split('|')
          .map((field) => field.split('=')),
      );
      if (!('pts' in fields) && !('width' in fields)) return;
      const pts = numeric(fields.pts),
        width = numeric(fields.width),
        height = numeric(fields.height);
      if (
        pts === null ||
        !Number.isSafeInteger(pts) ||
        width === null ||
        height === null ||
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width <= 0 ||
        height <= 0 ||
        (lastPts !== null && pts <= lastPts)
      )
        throw new FramesError(
          'TIMELINE_UNAVAILABLE',
          '视频帧缺少可靠时间戳、顺序异常或尺寸无效，无法定位来源。',
        );
      lastPts = pts;
      const currentIndex = index++;
      const time = (pts * context.timeBase[0]) / context.timeBase[1] - context.start;
      if (time < 0 || time >= context.duration) return;
      const sampleAspect = ratio(fields.sample_aspect_ratio);
      const candidate = {
        index: currentIndex,
        pts,
        time,
        width,
        height,
        sar: sampleAspect ? sampleAspect[0] / sampleAspect[1] : context.sar,
      };
      for (let i = 0; i < plan.times.length; i++) {
        const old = selected[i],
          target = plan.times[i]!;
        // Equal-distance ties retain the earlier frame.
        if (!old || Math.abs(time - target) < Math.abs(old.time - target) - 1e-9)
          selected[i] = candidate;
      }
    },
  };
}
