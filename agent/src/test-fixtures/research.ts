import { readFileSync } from 'node:fs';
import {
  GithubHotListSchema,
  ResearchAcceptedResultSchema,
  ResearchContextSchema,
} from '@multi-agent-ops/shared';
import { getGithubProjectResearchSkillMetadata } from '../agents/research/skills.js';

/** Transport/contract fixture only; repeated claims do not demonstrate semantic chapter coverage. */
export function loadResearchAgentFixture() {
  const fixture = JSON.parse(
    readFileSync(new URL('../../../shared/tests/fixtures/research.json', import.meta.url), 'utf8'),
  );
  const context = ResearchContextSchema.parse(fixture.context);
  const result = ResearchAcceptedResultSchema.parse(fixture.result);
  const skill = getGithubProjectResearchSkillMetadata();
  context.runtimeContext.skills = [skill];
  result.metadata.skills = [{ name: skill.name, version: skill.version }];
  const section = result.report.sections[0]!;
  result.report.sections = skill.requiredSections.map((requirement, index) => ({
    ...section,
    id: index === 0 ? section.id : `section-skill-${index}`,
    title: requirement.title,
    requirementRef: requirement.id,
    claimIds: [...section.claimIds],
    gapIds: [...section.gapIds],
  }));
  return { context, result, hotList: GithubHotListSchema.parse(fixture.hotList) };
}
