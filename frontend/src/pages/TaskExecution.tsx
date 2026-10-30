import { useEffect, useRef, useState } from 'react';
import type { ResponseModels, TaskDetail } from '@multi-agent-ops/shared';
import { useAuth } from '../auth.js';
import { Empty, Notice } from '../components.js';
import { getTaskHistory, runTaskCommand, TaskRequestError } from '../task-api.js';
import type { ExecutionCommand } from '../task-api.js';
import { executionLabels } from '../task-labels.js';

type Scenario = 'success' | 'failure' | 'clarification';
type Pending = { key: string; command: ExecutionCommand };
type ScenarioSelection = { attemptId: string | null; scenario: Scenario };
const roles = {
  supervisor: '检查原始要求',
  research: '模拟研究资料',
  content: '模拟生成文案',
  review: '模拟检查产出',
};
const stepStatus = {
  queued: '排队中',
  running: '执行中',
  completed: '完成',
  failed: '失败',
  cancelled: '已取消',
};
const scenarios = { success: '正常完成', failure: '研究步骤失败', clarification: '需要澄清' };
const date = (value: string | null) =>
  value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
function readPending(key: string): Pending | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw || raw.length > 5000) return null;
    const value = JSON.parse(raw) as Pending;
    const command = value.command;
    if (
      !/^[a-f0-9-]{36}$/.test(value.key) ||
      !command ||
      !Number.isSafeInteger(command.body.expectedRevision) ||
      command.body.expectedRevision < 1
    )
      return null;
    if (command.kind === 'stop')
      return typeof command.attemptId === 'string' && typeof command.body.reason === 'string'
        ? value
        : null;
    if (command.kind !== 'start' && command.kind !== 'retry') return null;
    if (
      command.body.simulationScenario &&
      !Object.hasOwn(scenarios, command.body.simulationScenario)
    )
      return null;
    if (
      command.kind === 'retry' &&
      (typeof command.body.previousAttemptId !== 'string' ||
        typeof command.body.reason !== 'string' ||
        command.body.restartTerminated !== false)
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

function readScenario(key: string): ScenarioSelection | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw || raw.length > 500) return null;
    const value = JSON.parse(raw) as ScenarioSelection;
    return value &&
      (value.attemptId === null || typeof value.attemptId === 'string') &&
      Object.hasOwn(scenarios, value.scenario)
      ? value
      : null;
  } catch {
    return null;
  }
}

export function useTaskExecution(detail: TaskDetail, onChanged: () => void) {
  const auth = useAuth();
  const storageKey = `ops-execution:${JSON.stringify([auth.session?.member.teamId, auth.session?.member.id, detail.task.id])}`;
  const scenarioKey = `${storageKey}:scenario`;
  const [pending, setPending] = useState<Pending | null>(() => readPending(storageKey));
  const [selection, setSelection] = useState(() => readScenario(scenarioKey));
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const active = !!(
    detail.currentAttempt &&
    ['queued', 'running', 'awaiting_clarification'].includes(detail.currentAttempt.status)
  );
  const scenario =
    (active ? detail.currentAttempt?.simulationScenario : null) ??
    (pending?.command.kind === 'start' || pending?.command.kind === 'retry'
      ? pending.command.body.simulationScenario
      : null) ??
    (selection?.attemptId === detail.task.currentAttemptId ? selection.scenario : null) ??
    detail.currentAttempt?.simulationScenario ??
    'success';
  function setScenario(value: Scenario) {
    const selected = { attemptId: detail.task.currentAttemptId, scenario: value };
    setSelection(selected);
    try {
      sessionStorage.setItem(scenarioKey, JSON.stringify(selected));
    } catch {
      /* Scenario selection is optional; the command always sends it explicitly. */
    }
  }

  async function submit(action: Pending) {
    if (working.current || !auth.session) return;
    working.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    setPending(action);
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(action));
    } catch {
      /* Server revision/attempt guards also prevent duplicate work after reload. */
    }
    try {
      const result = await runTaskCommand(
        detail.task.id,
        action.command,
        auth.session.csrfToken,
        action.key,
      );
      if (result.data.task.id !== detail.task.id)
        throw new TaskRequestError(
          202,
          'INVALID_RESPONSE',
          '操作结果尚未确认，请重试确认上次操作。',
          true,
        );
      setPending(null);
      try {
        sessionStorage.removeItem(storageKey);
      } catch {
        /* No credentials are stored. */
      }
      setNotice(
        action.command.kind === 'stop'
          ? '本次模拟执行已停止，历史记录已保留。'
          : '执行请求已保存，正在读取最新进度。',
      );
      onChanged();
    } catch (failure) {
      const issue =
        failure instanceof TaskRequestError
          ? failure
          : new TaskRequestError(
              0,
              'NETWORK_ERROR',
              '操作结果尚未确认，请重试确认上次操作。',
              true,
            );
      setError(issue.message);
      if (!issue.uncertain) {
        setPending(null);
        try {
          sessionStorage.removeItem(storageKey);
        } catch {
          /* Keep the current UI usable if storage is disabled. */
        }
        if ([409, 423].includes(issue.status)) onChanged();
      }
      if (issue.status === 401) void auth.refresh();
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  function command(kind: 'start' | 'retry' | 'stop', requestedScenario = scenario) {
    const body = { expectedRevision: detail.task.revision };
    const action: ExecutionCommand =
      kind === 'start'
        ? { kind, body: { ...body, simulationScenario: requestedScenario } }
        : kind === 'retry'
          ? {
              kind,
              body: {
                ...body,
                previousAttemptId: detail.task.currentAttemptId,
                restartTerminated: false,
                reason: '手动重新执行模拟任务',
                simulationScenario: requestedScenario,
              },
            }
          : {
              kind,
              attemptId: detail.task.currentAttemptId!,
              body: { ...body, reason: '手动停止模拟执行' },
            };
    void submit({ key: crypto.randomUUID(), command: action });
  }
  const generationAction = detail.currentAttempt ? detail.actions.retry : detail.actions.start;
  function generateClarification() {
    if (busy || pending || !generationAction.allowed) return;
    setScenario('clarification');
    command(detail.currentAttempt ? 'retry' : 'start', 'clarification');
  }
  return {
    pending,
    scenario,
    setScenario,
    busy,
    error,
    notice,
    active,
    submit,
    command,
    generationAction,
    generateClarification,
  };
}

export type TaskExecutionState = ReturnType<typeof useTaskExecution>;

export function TaskExecutionControls({
  detail,
  execution,
}: {
  detail: TaskDetail;
  execution: TaskExecutionState;
}) {
  const { pending, scenario, setScenario, busy, error, notice, active, submit, command } =
    execution;
  return (
    <section className="panel detail-panel" aria-labelledby="execution-controls-title">
      <h2 id="execution-controls-title">模拟执行</h2>
      <Notice>
        当前用于验证任务流程，不调用真实模型、搜索或微博发布。模拟产出不具备审核或发布资格。
      </Notice>
      {error && <Notice tone="danger">{error}</Notice>}
      {notice && <Notice tone="success">{notice}</Notice>}
      {pending && (
        <Notice tone="warning">上次操作尚未确认。刷新后仍保留同一操作标识，请先重试确认。</Notice>
      )}
      {detail.execution === 'awaiting_clarification' && (
        <Notice tone="warning">
          任务正在等待澄清，不会继续生成。请在“澄清问答”区补充答复，或停止本次尝试。
        </Notice>
      )}
      <label>
        模拟情形
        <select
          aria-label="模拟情形"
          value={scenario}
          disabled={busy || !!pending || !!active}
          onChange={(e) => setScenario(e.target.value as Scenario)}
        >
          {Object.entries(scenarios).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <div className="button-row">
        {!detail.currentAttempt && (
          <button
            className="primary"
            disabled={busy || !!pending || !detail.actions.start.allowed}
            title={detail.actions.start.reason ?? undefined}
            onClick={() => command('start')}
          >
            启动模拟执行
          </button>
        )}
        {detail.currentAttempt && !active && (
          <button
            className="primary"
            disabled={busy || !!pending || !detail.actions.retry.allowed}
            title={detail.actions.retry.reason ?? undefined}
            onClick={() => command('retry')}
          >
            重新执行
          </button>
        )}
        {active && (
          <button
            disabled={busy || !!pending || !detail.actions.stop.allowed}
            onClick={() => command('stop')}
          >
            停止本次执行
          </button>
        )}
        {pending && (
          <button
            disabled={busy}
            onClick={() => {
              void submit(pending);
            }}
          >
            重试确认上次操作
          </button>
        )}
      </div>
      {busy && <p role="status">正在确认操作…</p>}
      {!detail.currentAttempt && !detail.actions.start.allowed && (
        <p className="muted">{detail.actions.start.reason}</p>
      )}
    </section>
  );
}

export function TaskExecutionHistory({ taskId, revision }: { taskId: string; revision: number }) {
  const { refresh } = useAuth();
  const [history, setHistory] = useState<ResponseModels['History'] | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void getTaskHistory(taskId, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setHistory(value);
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        setError(failure instanceof Error ? failure.message : '执行记录加载失败。');
        if (failure instanceof TaskRequestError && failure.status === 401) void refresh();
      });
    return () => controller.abort();
  }, [taskId, revision, retry, refresh]);
  return (
    <section className="panel detail-panel" aria-labelledby="execution-history-title">
      <h2 id="execution-history-title">执行尝试记录</h2>
      {error && (
        <>
          <Notice tone="danger">{error}</Notice>
          <button onClick={() => setRetry((value) => value + 1)}>重试加载执行记录</button>
        </>
      )}
      {!history && !error && <p role="status">正在读取执行记录…</p>}
      {history && !history.attempts.length && (
        <Empty title="尚无执行尝试">启动模拟执行后，将在这里保留每次执行及步骤记录。</Empty>
      )}
      {history?.attempts.map((attempt) => (
        <article
          className="inset execution-attempt"
          key={attempt.id}
          data-testid="execution-attempt"
        >
          <div className="panel-heading">
            <h3>第 {attempt.attemptNo} 次执行</h3>
            <span className="pill">{executionLabels[attempt.status]}</span>
          </div>
          <p className="muted">
            {attempt.executorMode === 'mock' ? '模拟执行' : '真实执行'} ·{' '}
            {attempt.simulationScenario ? scenarios[attempt.simulationScenario] : '—'}
          </p>
          <dl className="task-metadata">
            <dt>执行编号</dt>
            <dd>{attempt.id}</dd>
            <dt>发起人 ID</dt>
            <dd>{attempt.requestedBy}</dd>
            <dt>创建时间</dt>
            <dd>{date(attempt.createdAt)}</dd>
            <dt>开始时间</dt>
            <dd>{date(attempt.startedAt)}</dd>
            <dt>结束时间</dt>
            <dd>{date(attempt.finishedAt)}</dd>
            <dt>当前步骤</dt>
            <dd>{attempt.currentStep ?? '—'}</dd>
          </dl>
          {attempt.error && <Notice tone="danger">{attempt.error.message}</Notice>}
          {attempt.cancelReason && <p>停止原因：{attempt.cancelReason}</p>}
          {history.clarificationAnswers
            .filter((answer) => answer.attemptId === attempt.id)
            .map((answer) => (
              <div className="inset" key={answer.id} data-testid="clarification-history">
                <strong className="task-original">{answer.question}</strong>
                <p className="task-original">{answer.answer}</p>
                <small>
                  答复人：{answer.answeredBy} · {date(answer.answeredAt)}
                </small>
              </div>
            ))}
          <ol className="execution-steps">
            {history.steps
              .filter((step) => step.attemptId === attempt.id)
              .map((step) => (
                <li key={step.id}>
                  <strong>{roles[step.role]}</strong>
                  <span>
                    {stepStatus[step.status]}
                    {step.durationMs !== null ? ` · ${step.durationMs} ms` : ''}
                  </span>
                  {step.error && <p>{step.error.message}</p>}
                </li>
              ))}
          </ol>
        </article>
      ))}
    </section>
  );
}
