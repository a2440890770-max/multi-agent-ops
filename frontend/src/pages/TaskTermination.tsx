import { useEffect, useRef, useState } from 'react';
import type { OperationBodies, TaskDetail } from '@multi-agent-ops/shared';
import { useAuth } from '../auth.js';
import { Notice } from '../components.js';
import { getTaskDetail, TaskRequestError, terminateTask } from '../task-api.js';

type Pending = { key: string; body: OperationBodies['terminateTask'] };
function readPending(storageKey: string): Pending | null {
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (!raw || raw.length > 12000) return null;
    const value = JSON.parse(raw) as Pending;
    return value &&
      /^[a-f0-9-]{36}$/.test(value.key) &&
      value.body &&
      Number.isSafeInteger(value.body.expectedRevision) &&
      value.body.expectedRevision > 0 &&
      typeof value.body.reason === 'string' &&
      !!value.body.reason.trim() &&
      value.body.reason.length <= 2000
      ? value
      : null;
  } catch {
    return null;
  }
}

export function TaskTermination({
  detail,
  onChanged,
  blocked = false,
}: {
  detail: TaskDetail;
  onChanged: () => void;
  blocked?: boolean;
}) {
  const auth = useAuth();
  const { task } = detail;
  const storageKey = `ops-termination:${JSON.stringify([auth.session?.member.teamId, auth.session?.member.id, task.id])}`;
  const [pending, setPending] = useState<Pending | null>(() => readPending(storageKey));
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const working = useRef(false);
  function clearPending() {
    setPending(null);
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      /* Revision checks still apply. */
    }
  }
  useEffect(() => {
    const saved = readPending(storageKey);
    if (task.lifecycle === 'terminated') {
      setPending(null);
      try {
        sessionStorage.removeItem(storageKey);
      } catch {
        /* The persisted task is authoritative. */
      }
    } else setPending(saved);
  }, [storageKey, task.lifecycle]);

  async function submit(action: Pending) {
    if (working.current || !auth.session) return;
    working.current = true;
    setBusy(true);
    setError('');
    setPending(action);
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(action));
    } catch {
      /* The server also protects repeats. */
    }
    try {
      const result = await terminateTask(task.id, action.body, auth.session.csrfToken, action.key);
      if (result.data.task.id !== task.id || result.data.task.lifecycle !== 'terminated')
        throw new TaskRequestError(
          202,
          'INVALID_RESPONSE',
          '终止结果尚未确认，请先查询任务。',
          true,
        );
      clearPending();
      setOpen(false);
      onChanged();
    } catch (failure) {
      const issue =
        failure instanceof TaskRequestError
          ? failure
          : new TaskRequestError(0, 'NETWORK_ERROR', '终止结果尚未确认，请先查询任务。', true);
      setError(issue.message);
      if (!issue.uncertain) {
        clearPending();
        if ([409, 423].includes(issue.status)) onChanged();
      }
      if (issue.status === 401) void auth.refresh();
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  async function query() {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      const current = await getTaskDetail(task.id, new AbortController().signal);
      if (current.task.lifecycle === 'terminated') {
        clearPending();
        setOpen(false);
        onChanged();
      } else setError('尚未查到任务终止。请核对任务后，显式重试确认原终止请求。');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '终止结果查询失败，请稍后重试。');
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="panel detail-panel" aria-labelledby="task-termination-title">
      <h2 id="task-termination-title">终止任务</h2>
      {task.lifecycle === 'terminated' ? (
        <>
          <Notice tone="warning">任务已终止，后续发布已被阻止。</Notice>
          <dl className="task-metadata">
            <dt>终止原因</dt>
            <dd data-testid="termination-reason">
              {task.terminationReason ?? '历史任务未记录原因'}
            </dd>
            <dt>终止时间</dt>
            <dd>
              {task.terminatedAt
                ? new Date(task.terminatedAt).toLocaleString('zh-CN', { hour12: false })
                : '未记录'}
            </dd>
            <dt>终止人 ID</dt>
            <dd>{task.terminatedBy ?? '未记录'}</dd>
          </dl>
        </>
      ) : (
        <>
          <p className="muted">
            终止会停止当前模拟执行并阻止后续发布，本期不支持恢复。仅需暂停生成以便改稿时，请使用“停止本次执行”。
          </p>
          {error && <Notice tone="danger">{error}</Notice>}
          {pending ? (
            <>
              <Notice tone="warning">上次终止结果尚未确认，请先查询；刷新不会自动重提。</Notice>
              <p>原终止原因：{pending.body.reason}</p>
              <div className="button-row">
                <button
                  disabled={busy}
                  onClick={() => {
                    void query();
                  }}
                >
                  查询终止结果
                </button>
                <button
                  disabled={busy}
                  onClick={() => {
                    void submit(pending);
                  }}
                >
                  重试确认原终止请求
                </button>
              </div>
            </>
          ) : open ? (
            <form
              aria-label="终止任务确认"
              onSubmit={(event) => {
                event.preventDefault();
                if (!reason.trim()) {
                  setError('请填写终止原因。');
                  return;
                }
                if (!detail.actions.terminate.allowed || blocked || busy) return;
                void submit({
                  key: crypto.randomUUID(),
                  body: { expectedRevision: task.revision, reason: reason.trim() },
                });
              }}
            >
              <Notice tone="warning">
                确认终止后，当前版本的批准将失效，任务不能再发起发布。此操作不会保存尚未提交的文案修改。
              </Notice>
              <label>
                终止原因
                <textarea
                  aria-label="终止原因"
                  maxLength={2000}
                  value={reason}
                  disabled={busy}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              <div className="button-row">
                <button
                  disabled={busy || blocked || !detail.actions.terminate.allowed}
                  type="submit"
                >
                  确认终止任务
                </button>
                <button
                  disabled={busy}
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    setError('');
                  }}
                >
                  暂不终止
                </button>
              </div>
            </form>
          ) : (
            <button
              disabled={busy || blocked || !detail.actions.terminate.allowed}
              title={detail.actions.terminate.reason ?? undefined}
              onClick={() => {
                setOpen(true);
                setError('');
              }}
            >
              终止任务
            </button>
          )}
          {!detail.actions.terminate.allowed && (
            <p className="muted">{detail.actions.terminate.reason}</p>
          )}
        </>
      )}
    </section>
  );
}
