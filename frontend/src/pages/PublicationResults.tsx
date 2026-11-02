import { useEffect, useRef, useState } from 'react';
import type {
  OperationBodies,
  PublishOperation,
  TaskDetail,
  VerificationRecord,
} from '@multi-agent-ops/shared';
import { useAuth } from '../auth.js';
import { Notice } from '../components.js';
import { publicationLabels } from '../task-labels.js';
import {
  readPublication,
  readPublicationHistory,
  recordPublicationResult,
} from '../publication-api.js';
import { TaskRequestError } from '../task-api.js';

type Fields = {
  conclusion: 'published' | 'not_published' | 'unknown';
  url: string;
  uid: string;
  body: string;
  note: string;
  confirmed: boolean;
  fenced: boolean;
  baseRevision: number;
};
type Pending = {
  key: string;
  kind: 'backfill' | 'verification';
  body: OperationBodies['backfillPublication'];
};
const initial = (revision: number): Fields => ({
  conclusion: 'published',
  url: '',
  uid: '',
  body: '',
  note: '',
  confirmed: false,
  fenced: false,
  baseRevision: revision,
});
function stored<T>(key: string, valid: (value: unknown) => value is T): T | null {
  try {
    const v: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    return valid(v) ? v : null;
  } catch {
    return null;
  }
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';
function validFields(v: unknown): v is Fields {
  return (
    object(v) &&
    ['published', 'not_published', 'unknown'].includes(v.conclusion as string) &&
    ['url', 'uid', 'body', 'note'].every((k) => typeof v[k] === 'string') &&
    String(v.body).length <= 20000 &&
    String(v.note).length <= 2000 &&
    typeof v.confirmed === 'boolean' &&
    typeof v.fenced === 'boolean' &&
    Number.isSafeInteger(v.baseRevision)
  );
}
function validPending(v: unknown): v is Pending {
  return (
    object(v) &&
    typeof v.key === 'string' &&
    /^[a-f0-9-]{36}$/.test(v.key) &&
    ['backfill', 'verification'].includes(v.kind as string) &&
    object(v.body) &&
    Number.isSafeInteger(v.body.expectedRevision) &&
    typeof v.body.dispatchId === 'string' &&
    typeof v.body.note === 'string' &&
    ['published', 'not_published', 'unknown'].includes(v.body.conclusion as string)
  );
}
const save = (key: string, value: unknown) => {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Server records remain authoritative when browser storage is unavailable. */
  }
};
function canonicalUrl(value: string | undefined) {
  if (!value) return null;
  try {
    const u = new URL(value);
    u.search = '';
    u.hash = '';
    u.pathname = u.pathname.replace(/\/$/, '');
    if (u.hostname === 'www.weibo.com') u.hostname = 'weibo.com';
    return u.href;
  } catch {
    return value;
  }
}
function recorded(operation: PublishOperation, pending: Pending, actorId: string | undefined) {
  return operation.verifications.some(
    (r) =>
      r.actorId === actorId &&
      r.kind === pending.kind &&
      r.dispatchId === pending.body.dispatchId &&
      r.requestedConclusion === pending.body.conclusion &&
      r.note === pending.body.note &&
      r.observedBody === (pending.body.observedBody ?? null) &&
      r.observedAccountUid === (pending.body.observedAccountUid ?? null) &&
      r.url === canonicalUrl(pending.body.url) &&
      r.manualConfirmed === (pending.body.manualConfirmed ?? false) &&
      r.previousDispatchFenced === (pending.body.previousDispatchFenced ?? false),
  );
}
const conclusions = {
  published: '发布且与批准版一致',
  not_published: '明确未发布',
  unknown: '不确定或存在差异',
};
const date = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false });

export function VerificationHistory({ operation }: { operation: PublishOperation }) {
  if (!operation.verifications.length) return null;
  return (
    <section aria-label="回填与核实记录">
      <h4>回填与核实记录</h4>
      {operation.verifications.map((r: VerificationRecord) => (
        <details key={r.id} className="inset" open={!!r.mismatchNote}>
          <summary>
            {r.kind === 'backfill' ? '人工回填' : '追加人工核实'} · {conclusions[r.conclusion]} ·{' '}
            {date(r.createdAt)}
          </summary>
          <p>
            提交结论：{conclusions[r.requestedConclusion]} · 保存后状态：
            {publicationLabels[r.resultingStatus]}
          </p>
          <p>确认方式：人工核实 · 操作人：{r.actorId}</p>
          <p>
            实际账号 UID：{r.observedAccountUid ?? '未提供'} · 微博标识：
            {r.platformPostId ?? '未提供'}
          </p>
          {r.url && (
            <a href={r.url} target="_blank" rel="noopener noreferrer">
              查看回填微博
            </a>
          )}
          <p className="editorial-id">
            核实编号：{r.id} · 发送编号：{r.dispatchId}
          </p>
          <p className="editorial-id">实际正文摘要：{r.observedContentHash ?? '未提供'}</p>
          {r.observedBody !== null && (
            <label>
              实际发布正文
              <textarea
                aria-label={`实际发布正文 ${r.id}`}
                readOnly
                value={r.observedBody}
                rows={4}
              />
            </label>
          )}
          <p>核对说明：{r.note}</p>
          {r.mismatchNote && <Notice tone="warning">差异登记：{r.mismatchNote}</Notice>}
          {r.previousDispatchFenced && <p>操作人已确认原交接停止，不会继续发布。</p>}
        </details>
      ))}
    </section>
  );
}

export function PublicationResults({
  detail,
  operation,
  onChanged,
}: {
  detail: TaskDetail;
  operation: PublishOperation;
  onChanged: () => void;
}) {
  const auth = useAuth();
  const key = `ops-publication-result:${JSON.stringify([auth.session?.member.teamId, auth.session?.member.id, detail.task.id, operation.id, operation.currentDispatchId])}`;
  const [fields, setFields] = useState<Fields>(
    () => stored(key, validFields) ?? initial(detail.task.revision),
  );
  const [pending, setPending] = useState<Pending | null>(() =>
    stored(key + ':pending', validPending),
  );
  const [busy, setBusy] = useState(false),
    working = useRef(false);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [showPublishedForm, setShowPublishedForm] = useState(false);
  const [queried, setQueried] = useState(false);
  const live =
    operation.status === 'awaiting_manual' || operation.status === 'verification_required';
  const canSubmit = live || (operation.status === 'published' && showPublishedForm);
  const stale = fields.baseRevision !== detail.task.revision;
  useEffect(() => {
    save(key, fields);
  }, [key, fields]);
  useEffect(() => {
    if (pending && recorded(operation, pending, auth.session?.member.id)) {
      setPending(null);
      save(key + ':pending', null);
      setFields(initial(detail.task.revision));
      setNotice('已查询确认原回填或核实记录，无需重复提交。');
    }
  }, [operation, pending, key, auth.session?.member.id, detail.task.revision]);
  function edit<K extends keyof Fields>(name: K, value: Fields[K]) {
    setFields((old) => ({ ...old, [name]: value }));
    setError('');
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
      setError(e instanceof Error ? e.message : '无法查询回填结果。');
      if (e instanceof TaskRequestError && e.status === 401) void auth.refresh();
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  async function submit() {
    if (working.current || !auth.session) return;
    if (!pending) {
      if (!canSubmit || stale) return;
      if (!fields.note.trim()) {
        setError('请填写核对说明或未发布原因。');
        return;
      }
      if (
        fields.conclusion === 'published' &&
        (!fields.url.trim() || !fields.uid.trim() || !fields.body.trim() || !fields.confirmed)
      ) {
        setError('请填写微博单条链接、实际账号 UID 和实际正文，并完成人工核对确认。');
        return;
      }
      if (fields.conclusion === 'not_published' && (!fields.confirmed || !fields.fenced)) {
        setError('请确认未发布，并确认原交接已停止、不会再继续发布。');
        return;
      }
      if (
        fields.conclusion !== 'not_published' &&
        fields.uid &&
        !/^[1-9][0-9]{0,19}$/.test(fields.uid)
      ) {
        setError('实际账号 UID 须为有效数字 UID。');
        return;
      }
    }
    const action: Pending = pending ?? {
      key: crypto.randomUUID(),
      kind: operation.status === 'awaiting_manual' ? 'backfill' : 'verification',
      body: {
        expectedRevision: fields.baseRevision,
        accountId: operation.accountId,
        contentVersionId: operation.contentVersionId,
        dispatchId: operation.currentDispatchId,
        conclusion: fields.conclusion,
        evidenceIds: [],
        note: fields.note,
        manualConfirmed: fields.confirmed,
        previousDispatchFenced: fields.conclusion === 'not_published' && fields.fenced,
        ...(fields.conclusion !== 'not_published'
          ? {
              ...(fields.url.trim() ? { url: fields.url.trim() } : {}),
              ...(fields.uid ? { observedAccountUid: fields.uid } : {}),
              ...(fields.body ? { observedBody: fields.body } : {}),
            }
          : {}),
      },
    };
    working.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    setPending(action);
    save(key + ':pending', action);
    try {
      const { data } = await recordPublicationResult(
        detail.task.id,
        operation.id,
        action.kind,
        action.body,
        auth.session.csrfToken,
        action.key,
      );
      setPending(null);
      save(key + ':pending', null);
      setFields(initial(data.task.task.revision));
      setShowPublishedForm(false);
      setNotice(
        data.operation.status === 'published'
          ? '人工核实记录已保存，任务为已发布；如有差异请查看差异登记。'
          : data.operation.status === 'failed'
            ? '已确认未发布并结束本次交接，任务已解锁。'
            : '资料已保存，当前待核实，任务保持锁定。',
      );
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : '回填结果尚未确认。');
      if (e instanceof TaskRequestError && !e.uncertain) {
        setPending(null);
        save(key + ':pending', null);
      } else setQueried(false);
      if (e instanceof TaskRequestError && e.status === 401) void auth.refresh();
      onChanged();
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="publication-results" aria-label="人工发布结果">
      <VerificationHistory operation={operation} />
      {error && <Notice tone="danger">{error}</Notice>}
      {notice && <Notice>{notice}</Notice>}
      {pending && (
        <Notice tone="warning">
          上次回填结果尚未确认。先查询原交接；查不到原记录时再用原请求确认。不要再次发布微博。
        </Notice>
      )}
      {pending && (
        <div className="button-row">
          <button disabled={busy} onClick={() => void query()}>
            查询回填结果
          </button>
          <button disabled={busy || !queried} onClick={() => void submit()}>
            重试确认原回填
          </button>
        </div>
      )}
      {operation.status === 'published' && !showPublishedForm && !pending && (
        <button onClick={() => setShowPublishedForm(true)}>补充人工核实记录</button>
      )}
      {canSubmit && !pending && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <h4>{operation.status === 'awaiting_manual' ? '回填发布结果' : '追加人工核实'}</h4>
          <Notice>
            {operation.status === 'published'
              ? '已有成功发布事实；补充的矛盾证据会单独登记，不会撤销成功状态。'
              : '由有权限的操作人核对并确认。账号或正文有差异时将进入待核实，不能记为批准版发布成功。'}
          </Notice>
          {stale && (
            <Notice tone="warning">
              任务或核实结果已更新，以下输入已保留。请比较上方最新记录后再继续。
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  setFields((old) => ({
                    ...old,
                    baseRevision: detail.task.revision,
                    confirmed: false,
                    fenced: false,
                  }))
                }
              >
                已比较，使用当前任务版本继续
              </button>
            </Notice>
          )}
          <fieldset disabled={busy}>
            <label>
              回填结论
              <select
                aria-label="回填结论"
                value={fields.conclusion}
                onChange={(event) => {
                  edit('conclusion', event.target.value as Fields['conclusion']);
                  edit('confirmed', false);
                  edit('fenced', false);
                }}
              >
                <option value="published">已发布，填写实际账号和正文供核对</option>
                <option value="unknown">结果不确定或存在差异</option>
                <option value="not_published">明确未发布，结束本次交接</option>
              </select>
            </label>
            {fields.conclusion !== 'not_published' && (
              <>
                <label>
                  微博单条链接
                  <input
                    aria-label="微博单条链接"
                    type="url"
                    maxLength={2048}
                    required={fields.conclusion === 'published'}
                    placeholder="https://weibo.com/账号UID/微博标识"
                    value={fields.url}
                    onChange={(e) => edit('url', e.target.value)}
                  />
                </label>
                <label>
                  实际发布账号 UID
                  <input
                    aria-label="实际发布账号 UID"
                    inputMode="numeric"
                    maxLength={20}
                    required={fields.conclusion === 'published'}
                    value={fields.uid}
                    onChange={(e) => edit('uid', e.target.value)}
                    placeholder={`请核对冻结账号 ${operation.snapshot.account.platformAccountId}`}
                  />
                </label>
                <label>
                  实际发布正文
                  <textarea
                    aria-label="实际发布正文"
                    rows={6}
                    maxLength={20000}
                    required={fields.conclusion === 'published'}
                    value={fields.body}
                    onChange={(e) => edit('body', e.target.value)}
                  />
                </label>
                <p className="muted">
                  请从实际发布的微博核对并填写，保留全部空格和换行。系统会与冻结批准原文比较。
                </p>
              </>
            )}
            <label>
              {fields.conclusion === 'not_published' ? '未发布原因' : '核对说明 / 差异说明'}
              <textarea
                aria-label="核对说明或未发布原因"
                required
                rows={3}
                maxLength={2000}
                value={fields.note}
                onChange={(e) => edit('note', e.target.value)}
              />
            </label>
            <label className="account-check">
              <input
                type="checkbox"
                checked={fields.confirmed}
                onChange={(e) => edit('confirmed', e.target.checked)}
              />
              {fields.conclusion === 'not_published'
                ? '我已明确核实本次交接尚未发布'
                : '我已打开该条微博，核对实际账号和完整正文'}
            </label>
            {fields.conclusion === 'not_published' && (
              <label className="account-check">
                <input
                  type="checkbox"
                  checked={fields.fenced}
                  onChange={(e) => edit('fenced', e.target.checked)}
                />
                我确认原交接已停止，相关人员不会再继续发布
              </label>
            )}
            <button className="primary" type="submit" disabled={busy || stale}>
              {busy
                ? '正在保存结果…'
                : operation.status === 'awaiting_manual'
                  ? '提交结果回填'
                  : '提交人工核实'}
            </button>
          </fieldset>
        </form>
      )}
    </section>
  );
}

export function PublicationHistory({ detail }: { detail: TaskDetail }) {
  const [items, setItems] = useState<PublishOperation[]>([]),
    [error, setError] = useState(''),
    [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void readPublicationHistory(detail.task.id, controller.signal)
      .then((rows) => {
        if (!controller.signal.aborted) {
          setItems(rows);
          setError('');
        }
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : '交接历史暂不可读。');
      });
    return () => controller.abort();
  }, [detail.task.id, detail.task.revision, reload]);
  const history = items.filter((item) => item.id !== detail.currentPublication?.id);
  if (!history.length && !error) return null;
  return (
    <section className="inset" aria-label="历史人工交接">
      <h3>历史人工交接</h3>
      {error && (
        <>
          <Notice tone="warning">{error}</Notice>
          <button onClick={() => setReload((value) => value + 1)}>重新读取交接历史</button>
        </>
      )}
      {history.map((op) => (
        <details key={op.id}>
          <summary>
            V{op.snapshot.content.versionNo} · {publicationLabels[op.status]} · {date(op.createdAt)}
          </summary>
          <p className="editorial-id">交接编号：{op.id}</p>
          <p>
            冻结账号：{op.snapshot.account.displayName} · UID：
            {op.snapshot.account.platformAccountId}
          </p>
          <VerificationHistory operation={op} />
        </details>
      ))}
    </section>
  );
}
