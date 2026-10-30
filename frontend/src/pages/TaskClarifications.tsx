import { useRef, useState } from 'react';
import type { OperationBodies, TaskDetail } from '@multi-agent-ops/shared';
import { useAuth } from '../auth.js';
import { Notice } from '../components.js';
import { runTaskCommand, TaskRequestError } from '../task-api.js';
import type { TaskExecutionState } from './TaskExecution.js';

type Draft = {
  answers: Record<string, string>;
  pending: { key: string; body: OperationBodies['clarifyTask'] } | null;
};
function readDraft(key: string): Draft {
  const empty: Draft = { answers: {}, pending: null };
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw || raw.length > 850000) return empty;
    const value = JSON.parse(raw) as Draft;
    if (
      !value.answers ||
      typeof value.answers !== 'object' ||
      Array.isArray(value.answers) ||
      Object.entries(value.answers).some(
        ([id, answer]) =>
          !/^[A-Za-z0-9_-]{1,128}$/.test(id) || typeof answer !== 'string' || answer.length > 4000,
      )
    )
      return empty;
    if (value.pending) {
      const { key, body } = value.pending;
      if (
        !/^[a-f0-9-]{36}$/.test(key) ||
        !body ||
        !Number.isSafeInteger(body.expectedRevision) ||
        body.expectedRevision < 1 ||
        typeof body.attemptId !== 'string' ||
        !Array.isArray(body.answers) ||
        !body.answers.length ||
        body.answers.length > 100 ||
        body.answers.some(
          (answer) =>
            typeof answer.questionId !== 'string' ||
            typeof answer.answer !== 'string' ||
            !answer.answer.trim() ||
            answer.answer.length > 4000,
        )
      )
        return empty;
    }
    return { answers: value.answers, pending: value.pending ?? null };
  } catch {
    return empty;
  }
}

export function TaskClarifications({
  detail,
  onChanged,
  execution,
}: {
  detail: TaskDetail;
  onChanged: () => void;
  execution: TaskExecutionState;
}) {
  const auth = useAuth();
  const storageKey = `ops-clarification:${JSON.stringify([auth.session?.member.teamId, auth.session?.member.id, detail.task.id, detail.task.currentAttemptId])}`;
  const [draft, setDraft] = useState<Draft>(() => readDraft(storageKey));
  const draftRef = useRef(draft);
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const canAnswer =
    detail.task.lifecycle === 'open' &&
    detail.execution === 'awaiting_clarification' &&
    !!detail.currentAttempt &&
    detail.currentAttempt.status === 'awaiting_clarification';
  const locked = busy || !!draft.pending;
  function save(value: Draft) {
    draftRef.current = value;
    setDraft(value);
    try {
      if (!Object.keys(value.answers).length && !value.pending)
        sessionStorage.removeItem(storageKey);
      else sessionStorage.setItem(storageKey, JSON.stringify(value));
    } catch {
      /* Server revision and attempt checks also prevent duplicate submissions. */
    }
  }
  async function submit(pending: NonNullable<Draft['pending']>) {
    if (submitting.current || !auth.session) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    save({ ...draftRef.current, pending });
    try {
      const result = await runTaskCommand(
        detail.task.id,
        { kind: 'clarify', body: pending.body },
        auth.session.csrfToken,
        pending.key,
      );
      if (result.data.task.id !== detail.task.id)
        throw new TaskRequestError(
          202,
          'INVALID_RESPONSE',
          '答复提交结果尚未确认，请重试确认。',
          true,
        );
      save({ answers: {}, pending: null });
      setNotice(
        result.data.execution === 'awaiting_clarification'
          ? '答复已保存，仍有问题待答复，执行继续暂停。'
          : '答复已保存，将继续原来的模拟执行。',
      );
      onChanged();
    } catch (failure) {
      const issue =
        failure instanceof TaskRequestError
          ? failure
          : new TaskRequestError(0, 'NETWORK_ERROR', '答复提交结果尚未确认，请重试确认。', true);
      setError(issue.message);
      if (!issue.uncertain) {
        save({ ...draftRef.current, pending: null });
        if ([409, 423].includes(issue.status)) onChanged();
      }
      if (issue.status === 401) void auth.refresh();
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  function send() {
    if (submitting.current || draftRef.current.pending || !canAnswer) return;
    const answers = detail.task.clarifications
      .filter(
        (question) =>
          question.answer === null && draftRef.current.answers[question.questionId]?.trim(),
      )
      .map((question) => ({
        questionId: question.questionId,
        answer: draftRef.current.answers[question.questionId]!,
      }));
    if (!answers.length) {
      setError('请至少填写一条非空的澄清答复。');
      return;
    }
    void submit({
      key: crypto.randomUUID(),
      body: {
        expectedRevision: detail.task.revision,
        attemptId: detail.currentAttempt!.id,
        answers,
      },
    });
  }
  return (
    <section className="panel detail-panel" aria-labelledby="clarifications-title">
      <h2 id="clarifications-title">澄清问答</h2>
      {canAnswer && (
        <Notice>
          请补充下面的问题。全部问题答复后继续本次模拟执行，原始要求会保留。
          当前只检查答复是否填写，请确认信息已补齐。
        </Notice>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
      {notice && <Notice tone="success">{notice}</Notice>}
      {draft.pending && (
        <Notice tone="warning">
          上次答复的提交结果尚未确认，输入已保留；请复用原操作重试确认。
        </Notice>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
        aria-label="澄清答复表单"
      >
        {detail.task.clarifications.map((question, index) => (
          <div className="inset clarification-question" key={question.questionId}>
            <strong className="task-original">{question.question}</strong>
            {question.answer !== null ? (
              <p className="task-original" data-testid="saved-clarification-answer">
                {question.answer}
              </p>
            ) : canAnswer ? (
              <>
                <label htmlFor={`answer-${question.questionId}`}>答复 {index + 1}</label>
                <textarea
                  id={`answer-${question.questionId}`}
                  rows={4}
                  maxLength={4000}
                  disabled={locked}
                  value={draft.answers[question.questionId] ?? ''}
                  onChange={(event) =>
                    save({
                      ...draftRef.current,
                      answers: {
                        ...draftRef.current.answers,
                        [question.questionId]: event.target.value,
                      },
                    })
                  }
                  placeholder="填写本次任务需要补充的信息"
                />
              </>
            ) : (
              <p className="muted">未答复</p>
            )}
          </div>
        ))}
        {!detail.task.clarifications.length && (
          <div>
            <p className="muted">
              {execution.active
                ? detail.currentAttempt?.simulationScenario === 'clarification'
                  ? '正在生成澄清问题，完成后会自动显示答复输入框。'
                  : '本次执行未选择“需要澄清”。执行结束后，可点击下方按钮生成澄清问题。'
                : '当前没有澄清问题。点击下方按钮启动“需要澄清”的模拟执行，生成问题后即可填写答复。'}
            </p>
            {detail.currentAttempt && !execution.active && (
              <p className="muted">将创建新的执行尝试，已有执行记录会保留。</p>
            )}
            <button
              type="button"
              className="primary"
              disabled={
                execution.busy || !!execution.pending || !execution.generationAction.allowed
              }
              title={execution.generationAction.reason ?? undefined}
              onClick={execution.generateClarification}
            >
              生成澄清问题
            </button>
            {!execution.generationAction.allowed && !execution.active && (
              <p className="muted">{execution.generationAction.reason}</p>
            )}
          </div>
        )}
        {canAnswer && (
          <button className="primary" type="submit" disabled={locked}>
            提交澄清答复
          </button>
        )}
      </form>
      {draft.pending && (
        <button
          disabled={busy}
          onClick={() => {
            void submit(draft.pending!);
          }}
        >
          重试确认澄清答复
        </button>
      )}
      {busy && <p role="status">正在保存澄清答复…</p>}
    </section>
  );
}
