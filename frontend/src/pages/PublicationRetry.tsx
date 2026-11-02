import { useEffect, useRef, useState } from 'react';
import type {
  OperationBodies,
  PublishOperation,
  ResponseModels,
  TaskDetail,
} from '@multi-agent-ops/shared';
import { useAuth } from '../auth.js';
import { Notice } from '../components.js';
import { readPublication, retryManualPublication } from '../publication-api.js';
import { TaskRequestError } from '../task-api.js';
import { publicationLabels } from '../task-labels.js';

type Pending = { key: string; body: OperationBodies['retryPublication'] };
function pendingFrom(key: string): Pending | null {
  try {
    const p = JSON.parse(sessionStorage.getItem(key) ?? 'null') as Pending;
    if (
      p &&
      /^[a-f0-9-]{36}$/.test(p.key) &&
      p.body?.channel === 'manual' &&
      Number.isSafeInteger(p.body.expectedRevision) &&
      [
        'accountId',
        'contentVersionId',
        'contentHash',
        'approvalId',
        'previousDispatchId',
        'reason',
      ].every((k) => typeof (p.body as unknown as Record<string, unknown>)[k] === 'string')
    )
      return p;
  } catch {
    /* Only an original command can be retried. */
  }
  return null;
}
const store = (key: string, value: Pending | null) => {
  try {
    if (value) sessionStorage.setItem(key, JSON.stringify(value));
    else sessionStorage.removeItem(key);
  } catch {
    /* Preserve the original command in memory when storage is unavailable. */
  }
};
export function PublicationRetry({
  detail,
  operation,
  editorialBlocked,
  onChanged,
}: {
  detail: TaskDetail;
  operation: PublishOperation;
  editorialBlocked: boolean;
  onChanged: () => void;
}) {
  const auth = useAuth();
  const key = `ops-publication-retry:${JSON.stringify([auth.session?.member.teamId, auth.session?.member.id, detail.task.id, operation.id])}`;
  const [pending, setPending] = useState<Pending | null>(() => pendingFrom(key));
  const [preview, setPreview] = useState<ResponseModels['Publication'] | null>(null);
  const [reason, setReason] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false),
    [queried, setQueried] = useState(false);
  const working = useRef(false),
    controller = useRef<AbortController | null>(null);
  useEffect(() => {
    controller.current?.abort();
    setPreview(null);
    if (!working.current) setBusy(false);
    return () => controller.current?.abort();
  }, [detail.task.revision, editorialBlocked]);
  useEffect(() => {
    if (
      pending &&
      operation.dispatches.some((d) => d.previousDispatchId === pending.body.previousDispatchId)
    ) {
      setPending(null);
      store(key, null);
      setPreview(null);
      setNotice('已确认原重新交接结果，已复用现有发送记录。');
    }
  }, [pending, operation, key]);
  const allowed =
    operation.status === 'failed' &&
    detail.actions.retry_publish.allowed &&
    !editorialBlocked &&
    !pending;
  const disabledReason = editorialBlocked
    ? '有未保存修改或编辑审核请求尚未确认，请先处理后再重新交接。'
    : detail.actions.retry_publish.reason;
  async function open() {
    if (!allowed || busy) return;
    const request = new AbortController();
    controller.current?.abort();
    controller.current = request;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const { data } = await readPublication(detail.task.id, operation.id, request.signal);
      if (request.signal.aborted) return;
      if (
        data.task.task.revision !== detail.task.revision ||
        data.operation.currentDispatchId !== operation.currentDispatchId ||
        data.task.currentPublication?.id !== operation.id ||
        !data.task.actions.retry_publish.allowed
      ) {
        setError(data.task.actions.retry_publish.reason ?? '交接或批准已变化，请刷新后重新核对。');
        onChanged();
        return;
      }
      setPreview(data);
    } catch (e) {
      if (request.signal.aborted) return;
      setError(e instanceof Error ? e.message : '重新交接信息暂不可读。');
      if (e instanceof TaskRequestError && e.status === 401) void auth.refresh();
    } finally {
      if (!request.signal.aborted) setBusy(false);
    }
  }
  async function query() {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      await readPublication(detail.task.id, operation.id);
      setQueried(true);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : '无法查询原交接。');
      if (e instanceof TaskRequestError && e.status === 401) void auth.refresh();
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  async function submit() {
    if (working.current || !auth.session || (!pending && (!preview || !allowed))) return;
    if (!pending && !reason.trim()) {
      setError('请填写本次重新交接原因。');
      return;
    }
    const source = preview?.operation;
    const action: Pending = pending ?? {
      key: crypto.randomUUID(),
      body: {
        expectedRevision: preview!.task.task.revision,
        accountId: source!.accountId,
        contentVersionId: source!.contentVersionId,
        contentHash: source!.contentHash,
        approvalId: source!.snapshot.approval.id,
        channel: 'manual',
        previousDispatchId: source!.currentDispatchId,
        reason: reason.trim(),
      },
    };
    working.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    setPending(action);
    store(key, action);
    try {
      await retryManualPublication(
        detail.task.id,
        operation.id,
        action.body,
        auth.session.csrfToken,
        action.key,
      );
      setPending(null);
      store(key, null);
      setPreview(null);
      setReason('');
      setNotice('重新交接已创建，文案再次锁定，请按本次交接手动发布。');
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : '重新交接结果尚未确认。');
      if (e instanceof TaskRequestError && !e.uncertain) {
        setPending(null);
        store(key, null);
        setPreview(null);
      } else setQueried(false);
      if (e instanceof TaskRequestError && e.status === 401) void auth.refresh();
      onChanged();
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      {operation.dispatches.length > 1 && (
        <section aria-label="发送交接历史">
          <h4>发送交接历史</h4>
          {operation.dispatches.map((d) => (
            <details key={d.id} className="inset">
              <summary>
                第 {d.dispatchNo} 次人工交接 · {publicationLabels[d.status]}
              </summary>
              <p className="editorial-id">发送编号：{d.id}</p>
              <p className="editorial-id">前次发送编号：{d.previousDispatchId ?? '首次交接'}</p>
              <p>
                交接人：{d.startedBy} · 时间：{new Date(d.startedAt).toLocaleString('zh-CN')}
              </p>
              {d.reason && <p>重新交接原因：{d.reason}</p>}
            </details>
          ))}
        </section>
      )}
      {notice && <Notice>{notice}</Notice>}
      {error && <Notice tone="danger">{error}</Notice>}
      {pending && (
        <>
          <Notice tone="warning">
            重新交接结果尚未确认。先查询原操作，再使用原请求确认，不要重复发布。
          </Notice>
          <div className="button-row">
            <button disabled={busy} onClick={() => void query()}>
              查询重新交接结果
            </button>
            <button disabled={busy || !queried} onClick={() => void submit()}>
              重试确认原重新交接
            </button>
          </div>
        </>
      )}
      {operation.status === 'failed' && !pending && (
        <section aria-label="重新人工交接">
          <h4>同版本重新交接</h4>
          <button className="primary" disabled={!allowed || busy} onClick={() => void open()}>
            重新人工交接
          </button>
          {disabledReason && <p className="disabled-reason">{disabledReason}</p>}
          {preview && (
            <form
              className="inset"
              aria-label="重新人工交接确认"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <h4>重新人工交接确认</h4>
              <p>
                目标账号：{preview.operation.snapshot.account.displayName} · UID：
                {preview.operation.snapshot.account.platformAccountId}
              </p>
              <p>
                批准版本：V{preview.operation.snapshot.content.versionNo} · 原批准人：
                {preview.operation.snapshot.approval.approvedBy}
              </p>
              <p className="editorial-id">原交接编号：{preview.operation.id}</p>
              <p className="editorial-id">上次发送编号：{preview.operation.currentDispatchId}</p>
              <p>
                上次未发布原因：
                {
                  preview.operation.verifications
                    .filter((r) => r.dispatchId === preview.operation.currentDispatchId)
                    .at(-1)?.note
                }
              </p>
              <label>
                原批准文案（重新交接核对）
                <textarea
                  aria-label="原批准文案（重新交接核对）"
                  rows={6}
                  readOnly
                  value={preview.operation.snapshot.content.body}
                />
              </label>
              <label>
                本次重新交接原因
                <textarea
                  aria-label="本次重新交接原因"
                  rows={3}
                  required
                  maxLength={2000}
                  disabled={busy}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              <Notice>
                确认后复用原交接编号，新增一条发送记录，文案再次锁定并进入待人工发布。此操作不会自动发布微博。
              </Notice>
              <div className="button-row">
                <button className="primary" type="submit" disabled={busy || !allowed}>
                  确认重新交接并锁定文案
                </button>
                <button type="button" disabled={busy} onClick={() => setPreview(null)}>
                  关闭重新交接确认
                </button>
              </div>
            </form>
          )}
        </section>
      )}
    </>
  );
}
