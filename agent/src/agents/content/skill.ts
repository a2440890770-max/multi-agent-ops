import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ContentError } from './types.js';

export const CONTENT_SKILL = {
  id: 'github-project-content',
  version: '1.0.0',
  sha256: '04f2646aea0d697bf29da4aadf225ec672dad2a8cff5ca8180ec76b7d2533710',
} as const;

/** A bundled registry entry, never a path or URL supplied by a model/user. */
export async function loadContentSkill(ref: { id: string; version: string }) {
  if (ref.id !== CONTENT_SKILL.id || ref.version !== CONTENT_SKILL.version)
    throw new ContentError('CONTENT_SKILL_NOT_CONFIGURED', '未配置请求的创作 Skill 版本。');
  let instructions: string;
  try {
    instructions = (
      await readFile(
        new URL('../../../skills/github-project-content/SKILL.md', import.meta.url),
        'utf8',
      )
    ).replace(/\r\n/g, '\n');
  } catch {
    throw new ContentError('CONTENT_SKILL_UNAVAILABLE', '创作 Skill 文件不可读取。');
  }
  const sha256 = createHash('sha256').update(instructions).digest('hex');
  if (sha256 !== CONTENT_SKILL.sha256)
    throw new ContentError(
      'CONTENT_SKILL_VERSION_MISMATCH',
      'Skill 内容与固定版本不一致，请更新注册记录。',
    );
  return { ...CONTENT_SKILL, instructions };
}
