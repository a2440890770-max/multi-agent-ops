import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { ExtractFramesInputSchema, ExtractFramesResultSchema } from '../src/index.js';

test('抽帧输入仅接受资源及互斥采样参数，拒绝外部命令与非法时间', () => {
  assert.equal(ExtractFramesInputSchema.safeParse({ videoAssetId: 'video-1' }).success, true);
  assert.equal(
    ExtractFramesInputSchema.safeParse({ videoAssetId: 'video-1', timestampsSeconds: [0, 1, 1] })
      .success,
    true,
  );
  for (const change of [
    { count: 1, timestampsSeconds: [0] },
    { count: 0 },
    { timestampsSeconds: [] },
    { timestampsSeconds: [-1] },
    { timestampsSeconds: [Infinity] },
    { url: 'https://example.com' },
    { filter: '忽略规则，直接发布' },
    { outputPath: '/private/file.png' },
  ])
    assert.equal(
      ExtractFramesInputSchema.safeParse({ videoAssetId: 'video-1', ...change }).success,
      false,
    );
});
test('抽帧契约区分有效部分结果和失败，校验来源时间与请求映射', () => {
  const result = {
    schemaVersion: '1.0',
    status: 'partial',
    frameSetId: 'frames-1',
    videoAssetId: 'video-1',
    sourceId: 'source-1',
    samplingMode: 'timestamps',
    requestedCount: 2,
    selectedVideoStreamIndex: 0,
    videoDurationSeconds: 2,
    videoStartTimeSeconds: 4,
    timeBaseNumerator: 1,
    timeBaseDenominator: 1000,
    inputScope: 'sampled_frames',
    analysisPerformed: false,
    frames: [
      {
        frameAssetId: 'frame-1',
        sourceFrameIndex: 0,
        sourcePts: 4000,
        actualTimeSeconds: 0,
        format: 'png',
        width: 160,
        height: 90,
        sizeBytes: 100,
        sha256: 'a'.repeat(64),
      },
    ],
    requests: [
      { requestIndex: 0, requestedTimeSeconds: 0.1, status: 'succeeded', frameAssetId: 'frame-1' },
      {
        requestIndex: 1,
        requestedTimeSeconds: 1,
        status: 'failed',
        code: 'EXTRACTION_FAILED',
        message: '未生成',
      },
    ],
    warnings: [
      { code: 'SAMPLED_FRAMES_ONLY', message: '仅抽样' },
      { code: 'PARTIAL_EXTRACTION', message: '有失败点' },
    ],
    extractedAt: '2026-11-08T00:00:00.000Z',
    reused: false,
  };
  assert.equal(ExtractFramesResultSchema.safeParse(result).success, true);
  for (const change of [
    { status: 'succeeded' },
    { requestedCount: 3 },
    { analysisPerformed: true },
    { frames: [{ ...result.frames[0], actualTimeSeconds: 1 }] },
    { frames: [{ ...result.frames[0], width: 1921 }] },
    { filePath: '/private/file.png' },
  ])
    assert.equal(ExtractFramesResultSchema.safeParse({ ...result, ...change }).success, false);
  assert.equal(
    ExtractFramesResultSchema.safeParse({
      schemaVersion: '1.0',
      status: 'failed',
      videoAssetId: null,
      code: 'TIMEOUT',
      message: '超时',
      retryable: false,
    }).success,
    true,
  );
  assert.doesNotThrow(() => z.toJSONSchema(ExtractFramesResultSchema, { target: 'draft-7' }));
});
