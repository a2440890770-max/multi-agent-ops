import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk';
import type { ContentContext } from '@multi-agent-ops/shared';
import { z } from 'zod';
import { CONTENT_SKILL_TOOL } from './prompt.js';
import { ContentError } from './types.js';
import type { loadContentSkill } from './skill.js';
import { validateContentOutput } from './validation.js';

export function createContentPolicy(options: {
  context: ContentContext;
  skill: Awaited<ReturnType<typeof loadContentSkill>>;
  controller: AbortController;
  maxOutputAttempts: number;
  emit: (kind: 'skill_read' | 'output_rejected', code?: string) => void;
}) {
  let failure: ContentError | undefined;
  let skillRead = false;
  let outputAttempts = 0;
  let skillReads = 0;
  const inputSchema = z.strictObject({
    id: z.literal(options.skill.id),
    version: z.literal(options.skill.version),
  });
  const active = () => {
    if (failure) throw failure;
    if (options.controller.signal.aborted)
      throw new ContentError('CONTENT_CANCELLED', 'Content 已停止。');
  };
  const fail = (error: ContentError) => {
    failure ??= error;
    options.controller.abort();
    return failure;
  };
  function validateFinal(value: unknown) {
    active();
    if (!skillRead)
      throw new ContentError('CONTENT_SKILL_NOT_READ', '必须先通过工具读取创作 Skill。');
    return validateContentOutput(value, options.context);
  }
  const server = createSdkMcpServer({
    name: 'content',
    version: '1.0.0',
    tools: [
      tool(
        'read_content_skill',
        '读取当前 Content 授权的固定版本创作说明；不接受路径或 URL。',
        inputSchema.shape,
        async (args) => {
          active();
          if (!inputSchema.safeParse(args).success || ++skillReads > 2)
            throw fail(
              new ContentError('CONTENT_SKILL_TOOL_DENIED', 'Skill 请求无效或超过读取上限。'),
            );
          skillRead = true;
          options.emit('skill_read');
          return { content: [{ type: 'text', text: JSON.stringify(options.skill) }] };
        },
        {
          annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
          alwaysLoad: true,
        },
      ),
    ],
  });
  const pre: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    try {
      active();
      if (input.agent_id || ![CONTENT_SKILL_TOOL, 'StructuredOutput'].includes(input.tool_name))
        throw fail(
          new ContentError('CONTENT_TOOL_DENIED', 'Content 只能读取指定 Skill 和提交结构化结果。'),
        );
      if (
        input.tool_name === CONTENT_SKILL_TOOL &&
        !inputSchema.safeParse(input.tool_input).success
      )
        throw fail(
          new ContentError('CONTENT_SKILL_TOOL_DENIED', '不允许读取其他 Skill、版本或路径。'),
        );
      if (input.tool_name === 'StructuredOutput') {
        if (++outputAttempts > options.maxOutputAttempts)
          throw fail(
            new ContentError('CONTENT_OUTPUT_ATTEMPTS_EXHAUSTED', '结构化输出纠正次数已耗尽。'),
          );
        try {
          validateFinal(input.tool_input);
        } catch (error) {
          const code = error instanceof ContentError ? error.code : 'CONTENT_OUTPUT_INVALID';
          const reason = error instanceof ContentError ? error.message : '候选结果未通过校验。';
          options.emit('output_rejected', code);
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: `${code}：${reason}请对照 research.facts 的 kind 和 requiredQualifier 逐条纠正 claimRefs；不同类型的事实拆成独立引用，不得补充研究或改变权限。`,
            },
          };
        }
      }
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } };
    } catch (error) {
      const rejected = fail(
        error instanceof ContentError
          ? error
          : new ContentError('CONTENT_POLICY_FAILED', '工具权限检查失败。'),
      );
      return {
        continue: false,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: rejected.code,
        },
      };
    }
  };
  const toolFailure: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PostToolUseFailure' || input.tool_name === 'StructuredOutput')
      return {};
    return {
      continue: false,
      stopReason: fail(new ContentError('CONTENT_TOOL_FAILED', '创作工具执行失败，未自动重跑。'))
        .code,
    };
  };
  const hooks: Options['hooks'] = {
    PreToolUse: [{ hooks: [pre] }],
    PostToolUseFailure: [{ hooks: [toolFailure] }],
    SubagentStart: [
      {
        hooks: [
          async () => ({
            continue: false,
            stopReason: fail(
              new ContentError('CONTENT_TOOL_DENIED', 'Content 不允许分派子 Agent。'),
            ).code,
          }),
        ],
      },
    ],
  };
  return {
    server,
    hooks,
    validateFinal,
    get failure() {
      return failure;
    },
    get outputAttempts() {
      return outputAttempts;
    },
  };
}
