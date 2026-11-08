import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ContentOutputSchema } from '../../shared/src/index.ts';

const { values } = parseArgs({ options: { result: { type: 'string' } } });
if (!values.result?.endsWith('.output.json'))
  throw new Error('Provide --result with a .output.json file.');
const resultPath = resolve(values.result);
const result = JSON.parse(await readFile(resultPath, 'utf8'));
const output = ContentOutputSchema.parse(result.output);
const lines = [
  '# Content Agent 生成结果',
  '',
  `模型：${result.metadata.provider} / ${result.metadata.model}`,
  `Prompt：${result.metadata.promptVersion}；Skill：${result.metadata.skill.id} / ${result.metadata.skill.version}`,
  '',
  '状态：独立创作演示；结构与引用校验已通过，尚未独立审核或人工批准。',
  '',
  `生成摘要：${output.summary}`,
  '',
];
if (output.decision === 'draft') {
  const plan = output.plan;
  lines.push('## 标题', '', plan.title, '', '## 封面', '', plan.cover.headline);
  if (plan.cover.subtitle) lines.push('', plan.cover.subtitle);
  lines.push('', `画面建议：${plan.cover.visualBrief}`, '');
  plan.pages.forEach((page, index) => {
    lines.push(
      `## 第 ${index + 1} 页：${page.heading}`,
      '',
      page.body,
      '',
      `画面建议：${page.visualBrief}`,
      '',
    );
  });
  lines.push(
    '## 发布正文',
    '',
    plan.caption,
    '',
    plan.hashtags.map((tag) => (tag.startsWith('#') ? tag : `#${tag}`)).join(' '),
    '',
    `项目链接：${plan.projectUrl}`,
    '',
  );
  lines.push('## 制作说明', '', ...plan.productionNotes.map((note) => `- ${note}`), '');
  lines.push(
    '## 风险与默认选择',
    '',
    ...output.warnings.map((warning) => `- ${warning}`),
    ...output.defaultsUsed.map((item) => `- ${item.field}：${item.value}；${item.reason}`),
    '',
  );
  if (!output.warnings.length && !output.defaultsUsed.length)
    lines.push('未记录额外警告或默认选择。', '');
  lines.push('## 证据映射', '');
  for (const ref of output.claimRefs) {
    lines.push(
      `- ${ref.fieldPath}：${ref.claim}`,
      `  - 类型：${ref.kind}；事实：${ref.factIds.join('、')}；来源：${ref.sourceIds.join('、')}`,
    );
  }
} else {
  lines.push('## 等待处理', '', ...output.requests.map((request) => `- ${request}`));
}
const planPath = resultPath.replace(/\.output\.json$/, '.plan.md');
await writeFile(planPath, lines.join('\n') + '\n', { flag: 'wx' });
console.log(
  JSON.stringify({
    planFile: planPath,
    decision: output.decision,
    ...(output.decision === 'draft'
      ? { title: output.plan.title, pages: output.plan.pages.map((page) => page.heading) }
      : {}),
  }),
);
