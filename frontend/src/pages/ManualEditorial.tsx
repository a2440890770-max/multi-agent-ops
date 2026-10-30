import { useEffect, useRef, useState } from 'react';
import type {
  ContentVersion,
  ManualDecision,
  ResponseModels,
  ReviewCycle,
  TaskDetail,
} from '@multi-agent-ops/shared';
import { useAuth } from '../auth.js';
import { Notice } from '../components.js';
import { allEditorialPages, editorialRequest } from '../editorial-api.js';
import { TaskRequestError } from '../task-api.js';

type Draft = {
  body: string;
  baseBody: string;
  baseVersionId: string | null;
  baseRevision: number;
  note: string;
};
type Action = {
  kind: 'save' | 'review' | 'decision' | 'approve';
  path: string;
  key: string;
  body: Record<string, unknown>;
};
const labels = { pass: '通过', changes_required: '需要修改', manual_required: '等待人工裁决' };
const date = (at: string) => new Date(at).toLocaleString('zh-CN', { hour12: false });
function readDraft(key: string, detail: TaskDetail): Draft {
  try {
    const d = JSON.parse(sessionStorage.getItem(key) ?? 'null') as Draft;
    if (
      d &&
      typeof d.body === 'string' &&
      typeof d.baseBody === 'string' &&
      typeof d.note === 'string' &&
      d.body.length <= 20000 &&
      d.note.length <= 2000 &&
      Number.isSafeInteger(d.baseRevision) &&
      d.baseRevision > 0 &&
      (d.baseVersionId === null || typeof d.baseVersionId === 'string')
    )
      return d;
  } catch {
    /* Invalid browser drafts do not replace stored versions. */
  }
  return {
    body: detail.currentContent?.body ?? '',
    baseBody: detail.currentContent?.body ?? '',
    baseVersionId: detail.task.currentContentVersionId,
    baseRevision: detail.task.revision,
    note: '',
  };
}
function readAction(key: string, base: string): Action | null {
  try {
    const a = JSON.parse(sessionStorage.getItem(key) ?? 'null') as Action;
    if (
      a &&
      ['save', 'review', 'decision', 'approve'].includes(a.kind) &&
      /^[a-f0-9-]{36}$/.test(a.key) &&
      a.path.startsWith(base + '/') &&
      /^\/(content-versions|reviews(?:\/[a-f0-9-]{36}\/decisions)?|approvals)$/.test(
        a.path.slice(base.length),
      ) &&
      Number.isSafeInteger(a.body?.expectedRevision)
    )
      return a;
  } catch {
    /* Only this task's original command may be retried. */
  }
  return null;
}

export function ManualEditorial({
  detail,
  onChanged,
}: {
  detail: TaskDetail;
  onChanged: () => void;
}) {
  const auth = useAuth(),
    base = `/api/v1/tasks/${detail.task.id}`;
  const key = `ops-editorial:${JSON.stringify([auth.session?.member.teamId, auth.session?.member.id, detail.task.id])}`;
  const [draft, setDraft] = useState(() => readDraft(key, detail));
  const [pending, setPending] = useState(() => readAction(key + ':pending', base));
  const [busy, setBusy] = useState(false),
    working = useRef(false);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [compare, setCompare] = useState(false);
  const [versions, setVersions] = useState<ContentVersion[]>([]),
    [reviews, setReviews] = useState<ReviewCycle[]>([]);
  const [decisions, setDecisions] = useState<Record<string, ManualDecision[]>>({});
  const [loadError, setLoadError] = useState(''),
    [retry, setRetry] = useState(0),
    [selected, setSelected] = useState('');
  const [changes, setChanges] = useState<ResponseModels['CompareVersions'] | null>(null);
  const dirty = draft.body !== draft.baseBody;
  const locked = busy || !!pending;
  function saveDraft(value: Draft) {
    setDraft(value);
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* Version guards remain enforced on the server. */
    }
  }
  useEffect(() => {
    if (dirty || detail.task.revision < draft.baseRevision) return;
    const body = detail.currentContent?.body ?? '';
    if (
      draft.baseVersionId !== detail.task.currentContentVersionId ||
      draft.baseRevision !== detail.task.revision
    )
      saveDraft({
        ...draft,
        body,
        baseBody: body,
        baseVersionId: detail.task.currentContentVersionId,
        baseRevision: detail.task.revision,
      });
  }, [detail, draft, dirty]);
  useEffect(() => {
    const controller = new AbortController();
    setLoadError('');
    void Promise.all([
      allEditorialPages(base + '/content-versions', 'ContentVersions', controller.signal),
      allEditorialPages(base + '/reviews', 'Reviews', controller.signal),
    ])
      .then(async ([content, cycles]) => {
        const history = await Promise.all(
          cycles.map(
            async (r) =>
              [
                r.id,
                await allEditorialPages(
                  base + `/reviews/${r.id}/decisions`,
                  'Decisions',
                  controller.signal,
                ),
              ] as const,
          ),
        );
        if (!controller.signal.aborted) {
          setVersions(content);
          setReviews(cycles);
          setDecisions(Object.fromEntries(history));
        }
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted)
          setLoadError(e instanceof Error ? e.message : '版本与审核历史读取失败。');
      });
    return () => controller.abort();
  }, [base, detail.task.revision, retry]);
  async function submit(action: Action) {
    if (working.current || !auth.session) return;
    working.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    setPending(action);
    try {
      sessionStorage.setItem(key + ':pending', JSON.stringify(action));
    } catch {
      /* The server also guards retries. */
    }
    try {
      const model =
        action.kind === 'save'
          ? 'SaveContent'
          : action.kind === 'review'
            ? 'Review'
            : action.kind === 'decision'
              ? 'Decision'
              : 'ApprovalResult';
      const result = await editorialRequest(action.path, model, {
        body: action.body,
        csrf: auth.session.csrfToken,
        key: action.key,
        successStatus:
          action.kind === 'review' ? 202 : action.kind === 'approve' ? [200, 201] : 201,
      });
      if (action.kind === 'save') {
        const saved = result.data as ResponseModels['SaveContent'];
        if (saved.task.task.id !== detail.task.id)
          throw new TaskRequestError(0, 'INVALID_RESPONSE', '保存结果尚未确认，请重试确认。', true);
        saveDraft({
          ...draft,
          body: saved.content.body,
          baseBody: saved.content.body,
          baseVersionId: saved.content.id,
          baseRevision: saved.task.task.revision,
        });
      }
      setPending(null);
      sessionStorage.removeItem(key + ':pending');
      setNotice(
        action.kind === 'save'
          ? '新版本已保存，请提交基础审核。'
          : action.kind === 'review'
            ? '基础审核已完成，请查看下方问题与阻断项。'
            : action.kind === 'decision'
              ? '裁决理由已保存。未解决的意见仍会阻止批准。'
              : '已批准当前版本；修改文案、重新执行或变更配置后需要重新审核批准。',
      );
      onChanged();
    } catch (failure) {
      const issue =
        failure instanceof TaskRequestError
          ? failure
          : new TaskRequestError(0, 'NETWORK_ERROR', '操作结果尚未确认，请重试确认。', true);
      setError(issue.message);
      if (!issue.uncertain) {
        setPending(null);
        sessionStorage.removeItem(key + ':pending');
        if ([409, 423].includes(issue.status)) {
          setCompare(true);
          onChanged();
        }
      }
      if (issue.status === 401) void auth.refresh();
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  function command(kind: Action['kind'], body: Record<string, unknown>, suffix: string) {
    if (locked) return;
    void submit({ kind, path: base + suffix, key: crypto.randomUUID(), body });
  }
  const review = detail.currentReview;
  const subjective =
    review?.records.flatMap((r) => r.blockingIssues).filter((i) => i.kind === 'subjective') ?? [];
  const blocked =
    review?.records.some((r) => r.blockingIssues.some((i) => i.kind !== 'subjective')) ?? false;
  const latestDecision = review ? decisions[review.id]?.[0] : null;
  const accepted =
    !blocked &&
    subjective.length > 0 &&
    (detail.approval === 'approved' ||
      (!!latestDecision &&
        latestDecision.unresolvedIssues.length === 0 &&
        subjective.every((i) => latestDecision.acceptedIssues.includes(i.id))));
  const selectedVersion = versions.find((v) => v.id === selected);
  return (
    <>
      <section className="panel detail-panel" aria-labelledby="manual-editor-title">
        <h2 id="manual-editor-title">人工文案编辑</h2>
        <p className="muted">
          直接编写文案并保存新版本，再进行基础审核和批准，全程无需 Agent。每次保存都保留旧版本。
        </p>
        {error && <Notice tone="danger">{error}</Notice>}
        {notice && <Notice tone="success">{notice}</Notice>}
        {pending && <Notice tone="warning">上次操作结果尚未确认，输入和原请求已保留。</Notice>}
        {dirty && draft.baseVersionId !== detail.task.currentContentVersionId && (
          <Notice tone="warning">服务器已有新版本。你的输入仍保留，请比较后再决定如何保存。</Notice>
        )}
        <label>
          文案内容
          <textarea
            aria-label="文案内容"
            rows={8}
            maxLength={20000}
            value={draft.body}
            disabled={locked || !detail.actions.save.allowed}
            onChange={(e) => saveDraft({ ...draft, body: e.target.value })}
          />
        </label>
        <p className="muted">
          {[...draft.body].length} 字符；超过 280 字符可以保存，但会阻断审核通过和批准。
        </p>
        {!detail.actions.save.allowed && <p className="muted">{detail.actions.save.reason}</p>}
        <div className="button-row">
          <button
            className="primary"
            disabled={locked || !dirty || !draft.body.trim() || !detail.actions.save.allowed}
            onClick={() =>
              command(
                'save',
                {
                  expectedRevision: draft.baseRevision,
                  baseContentVersionId: draft.baseVersionId,
                  body: draft.body,
                },
                '/content-versions',
              )
            }
          >
            保存新版本
          </button>
          <button disabled={busy} onClick={() => setCompare(!compare)}>
            比较当前版本与我的输入
          </button>
          {pending && (
            <button disabled={busy} onClick={() => void submit(pending)}>
              重试确认上次编辑审核操作
            </button>
          )}
        </div>
        {compare && (
          <div className="editorial-comparison">
            <label>
              服务器当前版本
              <textarea
                aria-label="服务器当前版本"
                readOnly
                rows={6}
                value={detail.currentContent?.body ?? ''}
              />
            </label>
            <label>
              我的未保存输入
              <textarea aria-label="我的未保存输入" readOnly rows={6} value={draft.body} />
            </label>
            <p className="muted">核对差异后，可保留你的输入，以服务器当前版本为父版本继续编辑。</p>
            <button
              disabled={locked}
              onClick={() => {
                saveDraft({
                  ...draft,
                  baseBody: detail.currentContent?.body ?? '',
                  baseVersionId: detail.task.currentContentVersionId,
                  baseRevision: detail.task.revision,
                });
                setError('');
                setNotice('已保留你的输入，并更新基础版本。请核对文案后再保存。');
              }}
            >
              保留输入并使用当前版本为基础
            </button>
          </div>
        )}
        <label>
          主观审核意见（可选）
          <textarea
            aria-label="主观审核意见"
            rows={3}
            maxLength={2000}
            value={draft.note}
            disabled={locked}
            placeholder="例如：语气是否足够活泼，需要人工判断。"
            onChange={(e) => saveDraft({ ...draft, note: e.target.value })}
          />
        </label>
        <div className="button-row">
          <button
            disabled={locked || dirty || !detail.actions.review.allowed}
            title={detail.actions.review.reason ?? undefined}
            onClick={() =>
              command(
                'review',
                {
                  expectedRevision: detail.task.revision,
                  contentVersionId: detail.task.currentContentVersionId,
                  subjectiveNote: draft.note,
                },
                '/reviews',
              )
            }
          >
            提交基础审核
          </button>
          <button
            className="primary"
            disabled={
              locked || dirty || !detail.actions.approve.allowed || detail.approval === 'approved'
            }
            onClick={() =>
              command(
                'approve',
                {
                  expectedRevision: detail.task.revision,
                  contentVersionId: detail.task.currentContentVersionId,
                  contentHash: detail.currentContent!.contentHash,
                  reviewCycleId: review!.id,
                  accountId: detail.account!.id,
                },
                '/approvals',
              )
            }
          >
            批准当前版本
          </button>
        </div>
        {dirty && <p className="muted">存在未保存修改，请先保存新版本后审核和批准。</p>}
        <p className="muted">
          允许创建者批准自己的文案。基础审核只检查字符数、纯文案格式和禁止词；事实与表达质量需要人工核实。
        </p>
        {detail.currentApproval && (
          <Notice tone={detail.currentApproval.status === 'approved' ? 'success' : 'warning'}>
            批准记录：{detail.currentApproval.status === 'approved' ? '有效' : '已失效'} ·{' '}
            {detail.currentApproval.approvedBy} · {date(detail.currentApproval.approvedAt)}
            {detail.currentApproval.invalidatedReason &&
              ` · ${detail.currentApproval.invalidatedReason}`}
          </Notice>
        )}
      </section>
      <section className="panel detail-panel" aria-labelledby="manual-review-title">
        <h2 id="manual-review-title">审核问题与阻断项</h2>
        {!review ? (
          <p className="muted">当前版本尚未审核。</p>
        ) : (
          <>
            <p>
              审核版本：{review.currentVersionId} · 配置 V{review.configVersion}
            </p>
            {review.records.map((r) => (
              <div className="inset" key={r.id}>
                <strong>{accepted ? '主观意见已裁决接受' : labels[r.outcome]}</strong>
                <ul>
                  {r.checks.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
                {!r.blockingIssues.length && <p>基础检查通过，没有阻断项。</p>}
                {r.blockingIssues.map((i) => (
                  <p key={i.id} data-testid="review-issue">
                    <strong>{i.kind === 'subjective' ? '主观意见' : '确定性阻断'}</strong>：
                    {i.message}
                  </p>
                ))}
              </div>
            ))}
            {blocked && (
              <Notice tone="warning">
                确定性阻断不能人工放行。请修改文案、保存新版本后重新审核。
              </Notice>
            )}
            {accepted && (
              <Notice
                tone={
                  detail.approval === 'approved' || detail.actions.approve.allowed
                    ? 'success'
                    : 'warning'
                }
              >
                {detail.approval === 'approved'
                  ? '主观意见已裁决接受。当前版本已批准。'
                  : detail.actions.approve.allowed
                    ? '主观意见已裁决接受，可以批准当前版本。'
                    : '主观意见已裁决接受；当前批准资格已变化，请重新审核。'}
              </Notice>
            )}
            {!subjective.length &&
              !blocked &&
              !detail.actions.approve.allowed &&
              detail.task.lifecycle === 'open' && (
                <Notice tone="warning">当前审核不能用于批准，请按最新版本和配置重新审核。</Notice>
              )}
            {!!subjective.length && !blocked && !accepted && detail.approval !== 'approved' && (
              <DecisionForm
                key={review.id}
                review={review}
                storageKey={key + ':reason:' + review.id}
                disabled={locked || dirty || !!detail.workLock}
                onSubmit={(reason, accepted, unresolved) =>
                  command(
                    'decision',
                    {
                      expectedRevision: detail.task.revision,
                      contentVersionId: detail.task.currentContentVersionId,
                      reviewRecordId: review.records[0]!.id,
                      reason,
                      acceptedIssues: accepted,
                      unresolvedIssues: unresolved,
                      evidenceIds: [],
                    },
                    `/reviews/${review.id}/decisions`,
                  )
                }
              />
            )}
          </>
        )}
      </section>
      <section className="panel detail-panel" aria-labelledby="content-history-title">
        <h2 id="content-history-title">文案版本历史</h2>
        {loadError && (
          <>
            <Notice tone="warning">{loadError}</Notice>
            <button onClick={() => setRetry((n) => n + 1)}>重试加载版本与审核历史</button>
          </>
        )}
        {!versions.length && <p className="muted">保存文案后，这里会保留版本、父版本和摘要。</p>}
        {versions.map((v) => (
          <article className="inset" key={v.id} data-testid="content-version">
            <strong>
              V{v.versionNo} · {v.sourceKind === 'manual' ? '人工编辑' : '模拟产出'}
              {v.id === detail.task.currentContentVersionId ? ' · 当前版本' : ''}
            </strong>
            <p className="editorial-id">
              版本：{v.id}
              <br />
              父版本：{v.parentVersionId ?? '无（首版）'}
              <br />
              SHA-256：{v.contentHash}
            </p>
            <small>
              {date(v.createdAt)} · {v.createdBy}
            </small>
            <div className="button-row">
              <button
                onClick={() => {
                  setSelected(v.id);
                  setChanges(null);
                }}
              >
                查看 V{v.versionNo}
              </button>
            </div>
          </article>
        ))}
        {selectedVersion && (
          <div className="inset">
            <h3>历史版本 V{selectedVersion.versionNo} 预览</h3>
            <pre className="task-original">{selectedVersion.body}</pre>
            <button
              onClick={() => {
                void editorialRequest(
                  base +
                    '/content-comparison?' +
                    new URLSearchParams({
                      fromVersionId: selectedVersion.id,
                      toVersionId: detail.task.currentContentVersionId ?? selectedVersion.id,
                    }),
                  'CompareVersions',
                )
                  .then((r) => setChanges(r.data))
                  .catch((e) => setLoadError(String(e)));
              }}
            >
              比较所选版本与当前版本
            </button>
          </div>
        )}
        {changes && (
          <div className="inset editorial-diff" aria-label="已保存版本差异">
            {changes.changes.map((c, i) =>
              c.kind === 'insert' ? (
                <ins key={i}>{c.text}</ins>
              ) : c.kind === 'delete' ? (
                <del key={i}>{c.text}</del>
              ) : (
                <span key={i}>{c.text}</span>
              ),
            )}
          </div>
        )}
      </section>
      <section className="panel detail-panel">
        <h2>审核与裁决历史</h2>
        {!reviews.length && <p className="muted">尚无审核记录。</p>}
        {reviews.map((r) => (
          <article className="inset" key={r.id} data-testid="review-history">
            <strong>
              {date(r.createdAt)} · 原审核结论：{r.records.map((x) => labels[x.outcome]).join('、')}
            </strong>
            <p className="editorial-id">
              文案版本：{r.currentVersionId} · 配置 V{r.configVersion} · 审核人：{r.requestedBy}
            </p>
            {r.records
              .flatMap((x) => x.blockingIssues)
              .map((i) => (
                <p key={i.id}>
                  {i.kind === 'subjective' ? '主观意见' : '确定性阻断'}：{i.message}
                </p>
              ))}
            {(decisions[r.id] ?? []).map((d) => (
              <div className="inset" key={d.id} data-testid="decision-history">
                <strong>裁决理由</strong>
                <p className="task-original">{d.reason}</p>
                <p>
                  接受 {d.acceptedIssues.length} 项；未解决 {d.unresolvedIssues.length} 项
                </p>
                <small>
                  {d.actorId} · {date(d.createdAt)}
                </small>
              </div>
            ))}
          </article>
        ))}
      </section>
    </>
  );
}

function DecisionForm({
  review,
  storageKey,
  disabled,
  onSubmit,
}: {
  review: ReviewCycle;
  storageKey: string;
  disabled: boolean;
  onSubmit: (reason: string, accepted: string[], unresolved: string[]) => void;
}) {
  const [reason, setReason] = useState(() => {
    try {
      return sessionStorage.getItem(storageKey) ?? '';
    } catch {
      return '';
    }
  });
  const [accept, setAccept] = useState(false),
    [error, setError] = useState('');
  const issues = review.records
    .flatMap((r) => r.blockingIssues)
    .filter((i) => i.kind === 'subjective');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!reason.trim()) {
          setError('请填写有效的裁决理由。');
          return;
        }
        setError('');
        onSubmit(
          reason,
          accept ? issues.map((i) => i.id) : [],
          accept ? [] : issues.map((i) => i.id),
        );
      }}
    >
      <label>
        裁决结果
        <select
          aria-label="裁决结果"
          disabled={disabled}
          value={accept ? 'accept' : 'unresolved'}
          onChange={(e) => setAccept(e.target.value === 'accept')}
        >
          <option value="unresolved">仍需修改，保留未解决意见</option>
          <option value="accept">接受上述主观分歧，允许继续批准</option>
        </select>
      </label>
      <label>
        裁决理由
        <textarea
          aria-label="裁决理由"
          rows={3}
          maxLength={2000}
          value={reason}
          disabled={disabled}
          onChange={(e) => {
            setReason(e.target.value);
            try {
              sessionStorage.setItem(storageKey, e.target.value);
            } catch {
              /* Reason remains in memory. */
            }
          }}
        />
      </label>
      {error && <Notice tone="danger">{error}</Notice>}
      <button type="submit" disabled={disabled}>
        保存人工裁决
      </button>
    </form>
  );
}
