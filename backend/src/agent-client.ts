import {
  AgentRunRequestSchema,
  AgentRunResponseSchema,
  AgentRunCheckSchema,
  GithubHotAcquisitionSchema,
  validateResearchResult,
  validateSupervisorDecision,
  StructuredOutputDiagnosticSchema,
  type StructuredOutputDiagnostic,
  type AgentRunRequest,
  type AgentRunCheck,
} from '@multi-agent-ops/shared';

export class AgentServiceError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: number | null = null,
    readonly diagnostic?: StructuredOutputDiagnostic,
  ) {
    super(code);
  }
}
export class AgentClient {
  private readonly baseUrl: URL;
  constructor(
    private options: { baseUrl: string; serviceToken: string; fetch?: typeof globalThis.fetch },
  ) {
    this.baseUrl = new URL(options.baseUrl);
    if (
      !/^[a-f0-9]{64}$/.test(options.serviceToken) ||
      this.baseUrl.username ||
      this.baseUrl.password ||
      this.baseUrl.pathname !== '/' ||
      this.baseUrl.search ||
      this.baseUrl.hash ||
      !(
        this.baseUrl.protocol === 'https:' ||
        (this.baseUrl.protocol === 'http:' &&
          ['127.0.0.1', 'localhost', '[::1]'].includes(this.baseUrl.hostname))
      )
    )
      throw new Error('Agent 服务地址或服务间凭据无效。');
  }
  private async post(path: string, body: unknown, signal: AbortSignal): Promise<unknown> {
    try {
      const response = await (this.options.fetch ?? globalThis.fetch)(new URL(path, this.baseUrl), {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          Authorization: `Bearer ${this.options.serviceToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      if (reader) {
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            length += part.value.length;
            if (length > 16 * 1024 * 1024) throw new AgentServiceError('AGENT_RESPONSE_TOO_LARGE');
            chunks.push(part.value);
          }
        } finally {
          await reader.cancel();
        }
      }
      let data: unknown;
      try {
        data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new AgentServiceError('AGENT_RESPONSE_INVALID', response.status);
      }
      if (!response.ok) {
        const code =
          data &&
          typeof data === 'object' &&
          'error' in data &&
          data.error &&
          typeof data.error === 'object' &&
          'code' in data.error &&
          typeof data.error.code === 'string' &&
          /^[A-Z][A-Z0-9_]{1,100}$/.test(data.error.code)
            ? data.error.code
            : 'AGENT_EXECUTION_FAILED';
        const details = StructuredOutputDiagnosticSchema.safeParse(
          data &&
            typeof data === 'object' &&
            'error' in data &&
            data.error &&
            typeof data.error === 'object' &&
            'diagnostic' in data.error
            ? data.error.diagnostic
            : undefined,
        );
        throw new AgentServiceError(
          code,
          response.status,
          details.success ? details.data : undefined,
        );
      }
      return data;
    } catch (error) {
      if (error instanceof AgentServiceError) throw error;
      throw new AgentServiceError(
        signal.aborted ? 'AGENT_REQUEST_CANCELLED' : 'AGENT_NETWORK_ERROR',
      );
    }
  }
  async acquireHotList(value: AgentRunCheck, signal: AbortSignal) {
    const data = await this.post(
      '/internal/v1/github-hot',
      AgentRunCheckSchema.parse(value),
      signal,
    );
    const parsed = GithubHotAcquisitionSchema.safeParse(data);
    if (!parsed.success) throw new AgentServiceError('AGENT_HOT_LIST_INVALID');
    return parsed.data;
  }
  async runSupervisor(value: AgentRunRequest, signal: AbortSignal) {
    const request = AgentRunRequestSchema.parse(value);
    const data = await this.post('/internal/v1/supervisor/runs', request, signal);
    const parsed = AgentRunResponseSchema.safeParse(data);
    if (!parsed.success) throw new AgentServiceError('AGENT_RESPONSE_INVALID');
    const response = parsed.data;
    const { result } = response;
    if (
      response.runId !== request.runId ||
      result.metadata.inputSnapshotId !== request.context.execution.inputSnapshotId ||
      result.metadata.configVersion !== request.context.runtimePolicy.configVersion ||
      result.metadata.promptVersion !== request.context.runtimePolicy.promptVersion ||
      result.metadata.toolPolicyVersion !== request.context.runtimePolicy.toolPolicyVersion ||
      response.events.some((event) =>
        Object.entries(request.context.execution).some(
          ([key, value]) => event[key as keyof typeof request.context.execution] !== value,
        ),
      )
    )
      throw new AgentServiceError('AGENT_RESULT_SCOPE_INVALID');
    try {
      if (
        result.researchResults.length < request.acceptedResearchResults.length ||
        result.researchResults.length > request.acceptedResearchResults.length + 1
      )
        throw new Error('result count');
      for (const [index, old] of request.acceptedResearchResults.entries())
        if (JSON.stringify(result.researchResults[index]) !== JSON.stringify(old))
          throw new Error('history changed');
      for (const report of result.researchResults) {
        validateResearchResult(report);
        if (
          report.execution.taskId !== request.context.execution.taskId ||
          report.execution.attemptId !== request.context.execution.attemptId ||
          JSON.stringify(report.selectedProject) !== JSON.stringify(request.context.selectedProject)
        )
          throw new Error('report scope');
      }
      const fresh = result.researchResults.length > request.acceptedResearchResults.length;
      if (
        fresh &&
        (!request.research ||
          result.researchResults.at(-1)!.authorizationId !==
            request.context.researchContext.authorizationId ||
          result.researchResults.at(-1)!.execution.stepId !==
            request.context.researchContext.inputs?.stepId)
      )
        throw new Error('unapproved research');
      if (result.metadata.researchDispatched !== fresh) throw new Error('dispatch mismatch');
      validateSupervisorDecision(result.output, request.context, result.researchResults);
    } catch {
      throw new AgentServiceError('AGENT_RESULT_SCOPE_INVALID');
    }
    return response;
  }
}
