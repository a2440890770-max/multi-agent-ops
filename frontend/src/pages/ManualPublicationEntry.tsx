import { useEffect, useRef, useState } from 'react';
import type { OperationBodies, ResponseModels, TaskDetail } from '@multi-agent-ops/shared';
import { useAuth } from '../auth.js';
import { Notice } from '../components.js';
import { readManualPublicationEntry } from '../account-api.js';
import { createManualHandoff } from '../publication-api.js';
import { TaskRequestError } from '../task-api.js';
import { PublicationRetry } from './PublicationRetry.js';
import { PublicationResults } from './PublicationResults.js';
import { ManualPublicationGuide } from './ManualPublicationGuide.js';

type Pending = { key: string; body: OperationBodies['publishContent'] };
function readPending(key: string): Pending | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(key) ?? 'null') as Pending;
    if (
      v &&
      /^[a-f0-9-]{36}$/.test(v.key) &&
      v.body?.channel === 'manual' &&
      Number.isSafeInteger(v.body.expectedRevision) &&
      v.body.expectedRevision > 0 &&
      ['accountId', 'approvalId', 'contentVersionId', 'contentHash'].every(
        (k) => typeof (v.body as unknown as Record<string, unknown>)[k] === 'string',
      )
    )
      return v;
  } catch {
    /* An invalid stored command must not create a new handoff. */
  }
  return null;
}
export function ManualPublicationEntry({
  detail,
  editorialBlocked,
  onChanged,
}: {
  detail: TaskDetail;
  editorialBlocked: boolean;
  onChanged: () => void;
}) {
  const auth = useAuth();
  const storageKey = `ops-handoff:${JSON.stringify([auth.session?.member.teamId, auth.session?.member.id, detail.task.id])}`;
  const [pending, setPending] = useState<Pending | null>(() => readPending(storageKey));
  const working = useRef(false);
  const [preview, setPreview] = useState<ResponseModels['ManualPublicationEntry'] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    controller.current?.abort();
    setPreview(null);
    setBusy(false);
    return () => controller.current?.abort();
  }, [detail.task.revision, editorialBlocked]);
  const operation = detail.currentPublication;
  useEffect(() => {
    if (
      operation &&
      pending &&
      operation.contentVersionId === pending.body.contentVersionId &&
      operation.accountId === pending.body.accountId &&
      operation.contentHash === pending.body.contentHash
    ) {
      setPending(null);
      try {
        sessionStorage.removeItem(storageKey);
      } catch {
        /* The server remains authoritative. */
      }
    }
  }, [operation, pending, storageKey]);
  const availability = detail.actions.manual_publish_entry;
  const reason = editorialBlocked
    ? '有未保存修改或编辑审核请求尚未确认，请先处理后再进入。'
    : (availability?.reason ?? null);
  const allowed = !editorialBlocked && !pending && !!availability?.allowed;
  async function open() {
    if (!allowed || busy) return;
    const request = new AbortController();
    controller.current?.abort();
    controller.current = request;
    setBusy(true);
    setError('');
    setPreview(null);
    try {
      const { data } = await readManualPublicationEntry(detail.task.id, request.signal);
      if (request.signal.aborted) return;
      if (
        data.revision !== detail.task.revision ||
        data.content.id !== detail.currentContent?.id ||
        data.approval.id !== detail.currentApproval?.id
      ) {
        setError('账号或批准版本已变化，请刷新后重新核对。');
        onChanged();
        return;
      }
      setPreview(data);
    } catch (e) {
      if (request.signal.aborted) return;
      setError(e instanceof Error ? e.message : '无法核对人工发布入口，请稍后重试。');
      if (e instanceof TaskRequestError && [409, 423].includes(e.status)) onChanged();
      if (e instanceof TaskRequestError && e.status === 401) void auth.refresh();
    } finally {
      if (!request.signal.aborted) setBusy(false);
    }
  }
  async function handoff() {
    if (working.current || !auth.session || (!pending && (!preview || !allowed))) return;
    const action: Pending = pending ?? {
      key: crypto.randomUUID(),
      body: {
        expectedRevision: preview!.revision,
        accountId: preview!.account.id,
        contentVersionId: preview!.content.id,
        contentHash: preview!.content.contentHash,
        approvalId: preview!.approval.id,
        channel: 'manual',
      },
    };
    working.current = true;
    setBusy(true);
    setError('');
    setPending(action);
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(action));
    } catch {
      /* Preserve the key in memory. */
    }
    try {
      await createManualHandoff(detail.task.id, action.body, auth.session.csrfToken, action.key);
      setPending(null);
      setPreview(null);
      try {
        sessionStorage.removeItem(storageKey);
      } catch {
        /* Server record is durable. */
      }
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : '交接结果尚未确认。');
      if (e instanceof TaskRequestError && !e.uncertain) {
        setPending(null);
        setPreview(null);
        try {
          sessionStorage.removeItem(storageKey);
        } catch {
          /* Refresh rechecks eligibility. */
        }
      }
      onChanged();
      if (e instanceof TaskRequestError && e.status === 401) void auth.refresh();
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  if (operation) {
    const { snapshot } = operation;
    return (
      <section className="inset manual-publication-entry" aria-labelledby="frozen-handoff-title">
        <h3 id="frozen-handoff-title">人工发布交接记录</h3>
        <Notice
          tone={
            operation.status === 'published'
              ? 'success'
              : operation.status === 'verification_required'
                ? 'warning'
                : 'info'
          }
        >
          {
            {
              awaiting_manual: '待人工发布 · 文案已冻结，请在手动发布后回填结果。',
              verification_required:
                '发布结果待核实 · 文案保持冻结。请追加核实资料，避免再次发布。',
              published: '已人工核实发布成功 · 任务已结束，原文案保持只读。',
              failed:
                '已确认未发布 · 原交接已结束，任务已解锁。可核对资格后重新交接；改稿需保存新版本并重新审核批准。',
              publishing: '发布处理中 · 请等待结果或核实原交接。',
            }[operation.status]
          }
        </Notice>
        <p>
          目标账号：{snapshot.account.displayName} · 微博 UID：{snapshot.account.platformAccountId}
        </p>
        <a
          href={`https://weibo.com/u/${snapshot.account.platformAccountId}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          查看交接账号主页
        </a>
        <p>
          冻结版本：V{snapshot.content.versionNo} · 配置版本：V{snapshot.configVersion}
        </p>
        <p>
          批准人：{snapshot.approval.approvedBy} · 批准时间：
          {new Date(snapshot.approval.approvedAt).toLocaleString('zh-CN')}
        </p>
        <p>
          首次交接人：{operation.createdBy} · 冻结时间：
          {new Date(snapshot.frozenAt).toLocaleString('zh-CN')}
        </p>
        <p className="editorial-id">交接编号：{operation.id}</p>
        <p className="editorial-id">发送编号：{operation.currentDispatchId}</p>
        <p>
          本次交接人：
          {operation.dispatches.find((d) => d.id === operation.currentDispatchId)?.startedBy} ·
          本次交接时间：
          {new Date(
            operation.dispatches.find((d) => d.id === operation.currentDispatchId)!.startedAt,
          ).toLocaleString('zh-CN')}
        </p>
        <PublicationRetry
          key={operation.id}
          detail={detail}
          operation={operation}
          editorialBlocked={editorialBlocked}
          onChanged={onChanged}
        />
        <p className="editorial-id">批准编号：{snapshot.approval.id}</p>
        <p className="editorial-id">正文摘要：{snapshot.content.contentHash}</p>
        <ManualPublicationGuide
          key={`${operation.id}:${operation.currentDispatchId}`}
          operation={operation}
        />
        <p className="muted">交接账号、批准版本和正文快照已保存；刷新后可继续查看。</p>
        <PublicationResults
          key={`${operation.id}:${operation.currentDispatchId}`}
          detail={detail}
          operation={operation}
          onChanged={onChanged}
        />
      </section>
    );
  }
  return (
    <section className="inset manual-publication-entry" aria-labelledby="manual-publication-title">
      <h3 id="manual-publication-title">人工发布</h3>
      <p className="muted">批准后可核对目标账号和文案，再准备人工发布。</p>
      {error && <Notice tone="danger">{error}</Notice>}
      <button className="primary" disabled={!allowed || busy} onClick={() => void open()}>
        {busy ? '正在核对发布信息…' : '人工发布交接'}
      </button>
      {pending && (
        <Notice>
          上次交接结果尚待确认。请先刷新查询；如仍无记录，可使用原请求确认，系统会复用同一交接。
        </Notice>
      )}
      {pending && (
        <>
          <button disabled={busy} onClick={onChanged}>
            查询交接结果
          </button>
          <button disabled={busy} onClick={() => void handoff()}>
            重试确认原交接
          </button>
        </>
      )}
      {reason && <p className="disabled-reason">{reason}</p>}
      {preview && (
        <section className="inset" aria-labelledby="manual-confirm-title">
          <h3 id="manual-confirm-title">人工发布确认</h3>
          <p>
            <strong>目标账号：{preview.account.displayName}</strong>
          </p>
          <p>微博 UID：{preview.account.platformAccountId}</p>
          <a
            href={`https://weibo.com/u/${preview.account.platformAccountId}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            查看目标微博主页
          </a>
          <p>
            批准版本：V{preview.content.versionNo} · 批准人：{preview.approval.approvedBy}
          </p>
          <p className="editorial-id">正文摘要：{preview.content.contentHash}</p>
          <label>
            已批准文案（核对预览）
            <textarea
              aria-label="已批准文案（核对预览）"
              readOnly
              rows={6}
              value={preview.content.body}
            />
          </label>
          <Notice>
            确认后将保存目标账号、批准版本与原文快照，并锁定文案及相关账号配置。随后由有权限人员手动发布微博。
          </Notice>
          <button className="primary" disabled={busy || !allowed} onClick={() => void handoff()}>
            确认创建交接并冻结文案
          </button>
          <button disabled={busy} onClick={() => setPreview(null)}>
            关闭确认面板
          </button>
        </section>
      )}
    </section>
  );
}
