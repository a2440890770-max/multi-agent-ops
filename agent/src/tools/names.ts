import { z } from 'zod';

export const FETCH_VIDEO_SERVER_NAME = 'research_media';
export const FETCH_VIDEO_TOOL_NAME = 'mcp__research_media__fetch_video';
export const EXTRACT_AUDIO_TOOL_NAME = 'mcp__research_media__extract_audio';
export const TRANSCRIBE_AUDIO_TOOL_NAME = 'mcp__research_media__transcribe_audio';
export const EXTRACT_FRAMES_TOOL_NAME = 'mcp__research_media__extract_frames';
export const RESEARCH_MEDIA_TOOL_NAMES = [
  FETCH_VIDEO_TOOL_NAME,
  EXTRACT_AUDIO_TOOL_NAME,
  TRANSCRIBE_AUDIO_TOOL_NAME,
  EXTRACT_FRAMES_TOOL_NAME,
] as const;
export const ResearchToolNameSchema = z.enum([
  'WebSearch',
  'WebFetch',
  'Read',
  FETCH_VIDEO_TOOL_NAME,
  EXTRACT_AUDIO_TOOL_NAME,
  TRANSCRIBE_AUDIO_TOOL_NAME,
  EXTRACT_FRAMES_TOOL_NAME,
]);
export type ResearchToolName = z.infer<typeof ResearchToolNameSchema>;
