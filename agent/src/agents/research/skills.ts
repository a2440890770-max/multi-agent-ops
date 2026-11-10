import { readFileSync } from 'node:fs';
import type { ResearchContext } from '@multi-agent-ops/shared';

export const GITHUB_PROJECT_RESEARCH_SKILL_VERSION = '1.0.0';
const skillName = 'github-project-research';
const requiredSections = [
  { id: 'gpr-overview', title: '项目概述' },
  { id: 'gpr-capabilities', title: '核心功能与工作方式' },
  { id: 'gpr-use-cases', title: '适用场景与人群' },
  { id: 'gpr-differentiation', title: '特点与创新判断' },
  { id: 'gpr-prerequisites', title: '使用门槛与前提' },
  { id: 'gpr-limitations', title: '局限与风险' },
] as const;
type RuntimeContext = ResearchContext['runtimeContext'];
export type ResearchSkillMetadata = RuntimeContext['skills'][number];

export class ResearchSkillError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ResearchSkillError';
  }
}

/** Fixed package asset: works from both src/agents/research and dist/agents/research. */
export function loadGithubProjectResearchSkill(): {
  metadata: ResearchSkillMetadata;
  instructions: string;
} {
  let document: string;
  try {
    document = readFileSync(
      new URL('../../../skills/github-project-research/SKILL.md', import.meta.url),
      'utf8',
    ).replace(/\r\n/g, '\n');
  } catch {
    throw new ResearchSkillError(
      'RESEARCH_SKILL_UNAVAILABLE',
      '必需的项目研究 Skill 无法读取，未启动研究。',
    );
  }
  // This validates our bundled format, not arbitrary user-supplied YAML or Skill paths.
  const frontmatterEnd = document.indexOf('\n---\n', 4);
  const frontmatter = document.slice(4, frontmatterEnd).split('\n');
  const version = frontmatter
    .find((line) => line.startsWith('  version: '))
    ?.slice('  version: '.length)
    .trim()
    .replace(/^(['"])(.*)\1$/, '$2');
  const instructions = document.slice(frontmatterEnd + 5).trim();
  const sections = instructions
    .split('\n')
    .filter((line) => line.startsWith('| `gpr-'))
    .map((line) => {
      const columns = line.split('|');
      return { id: columns[1]?.trim().replace(/`/g, ''), title: columns[2]?.trim() };
    });
  if (
    !document.startsWith('---\n') ||
    frontmatterEnd < 4 ||
    !frontmatter.includes(`name: ${skillName}`) ||
    version !== GITHUB_PROJECT_RESEARCH_SKILL_VERSION ||
    !instructions ||
    JSON.stringify(sections) !== JSON.stringify(requiredSections)
  )
    throw new ResearchSkillError(
      'RESEARCH_SKILL_INVALID',
      '项目研究 Skill 的内容、版本或必需章节与打包配置不一致，未启动研究。',
    );
  return { metadata: getGithubProjectResearchSkillMetadata(), instructions };
}

/** Copy into a frozen task input; callers cannot mutate the package's section configuration. */
export function getGithubProjectResearchSkillMetadata(): ResearchSkillMetadata {
  return {
    name: skillName,
    version: GITHUB_PROJECT_RESEARCH_SKILL_VERSION,
    requiredSections: requiredSections.map((section) => ({ ...section })),
  };
}

/** Only the project research Skill is currently loaded; video Skill remains unavailable. */
export function validateResearchSkillRuntimeContext(context: RuntimeContext): void {
  const expected = getGithubProjectResearchSkillMetadata();
  const actual = context.skills[0];
  if (
    context.skills.length !== 1 ||
    !actual ||
    actual.name !== expected.name ||
    actual.version !== expected.version ||
    actual.requiredSections.length !== expected.requiredSections.length ||
    actual.requiredSections.some((section, index) => {
      const required = expected.requiredSections[index];
      return !required || section.id !== required.id || section.title !== required.title;
    })
  )
    throw new ResearchSkillError(
      'RESEARCH_SKILL_CONTEXT_MISMATCH',
      '研究输入声明的 Skill、版本或必需章节与实际加载内容不一致。',
    );
}
