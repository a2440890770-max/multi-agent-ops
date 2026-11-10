import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import {
  AgentRunRequestSchema,
  AgentRunResponseSchema,
  AgentRunCheckSchema,
  type AgentRunCheck,
  type AgentRunRequest,
  type SupervisorEvent,
  type ResearchExecutionCallback,
} from '@multi-agent-ops/shared';
import { runSupervisor } from './agents/supervisor/runtime.js';
import { SupervisorError, type SupervisorRunOptions } from './agents/supervisor/types.js';
import { readDeepSeekConfig } from './model-config.js';
import { fetchGithubHot, parseGithubHot, GithubHotError } from './integrations/xxapi/github-hot.js';
import { createProductionResearch } from './agents/research/production.js';
import type { ResearchWebOptions } from './tools/research-web/controller.js';

export const AGENT_SERVICE_BODY_LIMIT = 16 * 1024 * 1024;
export interface AgentServiceOptions {
  serviceToken?: string;
  backendBaseUrl: string;
  env?: NodeJS.ProcessEnv;
  concurrency?: number;
  /** Offline dependency injection only; production invokes the SDK entry point. */
  run?: typeof runSupervisor;
  checkRun?: (request: AgentRunCheck, signal: AbortSignal) => Promise<void>;
  acquireHotList?: (signal: AbortSignal) => Promise<ReturnType<typeof parseGithubHot>>;
  researchWeb?: Pick<ResearchWebOptions, 'readOriginal' | 'checkPublicAddress'>;
}

function authorized(header: string | undefined, token: string) {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(header ?? ''), digest(`Bearer ${token}`));
}
async function readBody(request: IncomingMessage) {
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const data = Buffer.from(chunk);
    length += data.length;
    if (length > AGENT_SERVICE_BODY_LIMIT) throw new ServiceError(413, 'REQUEST_TOO_LARGE');
    chunks.push(data);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new ServiceError(400, 'INVALID_JSON');
  }
}
class ServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

/** No database client, task poller or backend imports live in the Agent process. */
export function createAgentService(options: AgentServiceOptions) {
  const env = options.env ?? process.env;
  const token = options.serviceToken;
  if (token !== undefined && !/^[a-f0-9]{64}$/.test(token))
    throw new Error('AGENT_SERVICE_TOKEN 必须为 32 字节随机密钥的十六进制编码。');
  const backendUrl = new URL(options.backendBaseUrl);
  if (
    backendUrl.username ||
    backendUrl.password ||
    backendUrl.search ||
    backendUrl.hash ||
    backendUrl.pathname !== '/' ||
    !(
      backendUrl.protocol === 'https:' ||
      (backendUrl.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(backendUrl.hostname))
    )
  )
    throw new Error('Agent 后端地址必须为精确服务 origin；非本机地址必须使用 HTTPS。');
  const concurrency = options.concurrency ?? 1;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32)
    throw new Error('Agent 并发配置无效。');
  const inFlight = new Map<string, AbortController>();
  const used = new Set<string>();
  let closing = false;
  let modelConfigured = true;
  try {
    readDeepSeekConfig(env);
  } catch {
    modelConfigured = false;
  }
  const check =
    options.checkRun ??
    (async (request: AgentRunCheck, signal: AbortSignal) => {
      const response = await fetch(new URL('/internal/v1/agent-runs/check', backendUrl), {
        method: 'POST',
        redirect: 'error',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ServiceError(409, 'EXECUTION_AUTHORITY_LOST');
      }
      const data: unknown = await response.json();
      if (!data || typeof data !== 'object' || !('allowed' in data) || data.allowed !== true)
        throw new ServiceError(409, 'EXECUTION_AUTHORITY_LOST');
    });
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    const send = (status: number, data: unknown) => {
      if (!response.destroyed) {
        response.statusCode = status;
        response.end(JSON.stringify(data));
      }
    };
    if (request.method === 'GET' && request.url === '/health') {
      send(200, {
        service: 'agent',
        status: 'ok',
        stage: 'D1',
        mode: token && modelConfigured ? 'supervisor' : 'shell',
        canExecuteTasks: !!token && modelConfigured && !closing,
      });
      return;
    }
    if (!token) {
      send(503, { error: { code: 'AGENT_SERVICE_UNCONFIGURED' } });
      return;
    }
    if (!authorized(request.headers.authorization, token)) {
      send(401, { error: { code: 'UNAUTHENTICATED' } });
      return;
    }
    if (
      request.method !== 'POST' ||
      !['/internal/v1/supervisor/runs', '/internal/v1/github-hot'].includes(request.url ?? '')
    ) {
      send(404, { error: { code: 'NOT_FOUND' } });
      return;
    }
    if (closing || inFlight.size >= concurrency) {
      send(503, { error: { code: 'AGENT_BUSY' } });
      return;
    }
    const controller = new AbortController();
    const disconnected = () => {
      if (!response.writableEnded) controller.abort();
    };
    response.once('close', disconnected);
    let key: string | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let checking = false;
    try {
      const body = await readBody(request);
      const hotList = request.url === '/internal/v1/github-hot';
      const parsed = hotList
        ? AgentRunCheckSchema.safeParse(body)
        : AgentRunRequestSchema.safeParse(body);
      if (!parsed.success) throw new ServiceError(400, 'AGENT_INPUT_INVALID');
      const run = parsed.data;
      if (closing || inFlight.size >= concurrency) throw new ServiceError(503, 'AGENT_BUSY');
      const identity: AgentRunCheck =
        'context' in run
          ? {
              runId: run.runId,
              lease: run.lease,
              execution: run.context.execution,
              contextHash: createHash('sha256').update(JSON.stringify(run.context)).digest('hex'),
              phase: 'check',
            }
          : { ...run, phase: 'check' };
      // Reserve before the first await; concurrent duplicate HTTP requests cannot race.
      key = `${hotList ? 'hot' : 'supervisor'}:${run.runId}`;
      if (used.has(key)) {
        key = undefined;
        throw new ServiceError(409, 'AGENT_RUN_ALREADY_DISPATCHED');
      }
      if (used.size >= 10_000) {
        key = undefined;
        throw new ServiceError(503, 'AGENT_RUN_CAPACITY_REACHED');
      }
      used.add(key);
      inFlight.set(key, controller);
      await check({ ...identity, phase: 'begin' }, controller.signal);
      if (controller.signal.aborted) throw new ServiceError(409, 'AGENT_CANCELLED');
      heartbeat = setInterval(() => {
        if (checking) return;
        checking = true;
        void check(identity, controller.signal)
          .catch(() => controller.abort())
          .finally(() => {
            checking = false;
          });
      }, 5000);
      heartbeat.unref();
      if (hotList) {
        const result = options.acquireHotList
          ? await options.acquireHotList(controller.signal)
          : parseGithubHot(await fetchGithubHot({ env, signal: controller.signal }));
        await check(identity, controller.signal);
        send(200, result);
      } else {
        const supervisor = run as AgentRunRequest;
        if (!modelConfigured && !options.run)
          throw new ServiceError(503, 'SUPERVISOR_MODEL_CONFIGURATION_INVALID');
        const wantsResearch =
          supervisor.context.researchContext.authorizationId !== null &&
          !supervisor.context.researchContext.authorizationUsed;
        if (
          wantsResearch &&
          (!supervisor.research ||
            !supervisor.context.runtimePolicy.allowedSubagents.includes('research'))
        )
          throw new ServiceError(409, 'RESEARCH_NOT_CONFIGURED');
        if (supervisor.limits.maxBudgetUsd > 0.1)
          throw new ServiceError(400, 'SUPERVISOR_BUDGET_INVALID');
        if (supervisor.limits.timeoutMs > 900_000 || supervisor.limits.maxOutputAttempts > 3)
          throw new ServiceError(400, 'SUPERVISOR_LIMITS_INVALID');
        const events: SupervisorEvent[] = [];
        const runOptions: SupervisorRunOptions = {
          env,
          limits: supervisor.limits,
          maxTotalTokens: supervisor.maxTotalTokens,
          signal: controller.signal,
          acceptedResearchResults: supervisor.acceptedResearchResults,
          onEvent: (event) => {
            if (events.length < 1000) events.push(event);
          },
        };
        if (wantsResearch)
          runOptions.research = createProductionResearch({
            request: supervisor,
            env,
            ...(options.researchWeb ? { webOptions: options.researchWeb } : {}),
            checkRun: (signal) => check(identity, signal),
            callback: async (value: ResearchExecutionCallback, signal) => {
              const result = await fetch(new URL('/internal/v1/research/events', backendUrl), {
                method: 'POST',
                redirect: 'error',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(value),
                signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
              });
              if (!result.ok) {
                await result.body?.cancel();
                throw new ServiceError(409, 'RESEARCH_CALLBACK_REJECTED');
              }
              const data: unknown = await result.json();
              if (
                !data ||
                typeof data !== 'object' ||
                !('accepted' in data) ||
                data.accepted !== true
              )
                throw new ServiceError(409, 'RESEARCH_CALLBACK_REJECTED');
              return data as { accepted: boolean; replayed?: boolean; execute?: boolean };
            },
          });
        const result = await (options.run ?? runSupervisor)(supervisor.context, runOptions);
        await check(identity, controller.signal);
        send(
          200,
          AgentRunResponseSchema.parse({
            protocolVersion: 1,
            runId: supervisor.runId,
            result,
            events,
          }),
        );
      }
    } catch (error) {
      const known =
        error instanceof ServiceError ||
        error instanceof SupervisorError ||
        error instanceof GithubHotError;
      send(error instanceof ServiceError ? error.status : 502, {
        error: {
          code: known ? error.code : 'AGENT_EXECUTION_FAILED',
          retryable: false,
          ...(error instanceof SupervisorError && error.diagnostic
            ? { diagnostic: error.diagnostic }
            : {}),
        },
      });
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      response.removeListener('close', disconnected);
      if (key) inFlight.delete(key);
    }
  });
  server.requestTimeout = 30_000; // Request body only; the SDK owns the execution deadline.
  return {
    server,
    async close() {
      closing = true;
      for (const controller of inFlight.values()) controller.abort();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
