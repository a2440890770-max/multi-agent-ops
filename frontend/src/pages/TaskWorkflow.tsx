import { useRef, useState } from 'react';
import type { ReviewCycle, TaskDetail } from '@multi-agent-ops/shared';
import { useAuth } from '../auth.js';
import { Notice } from '../components.js';
import { runContentCommand, runTaskCommand, TaskRequestError } from '../task-api.js';
import type { ContentCommand } from '../task-api.js';

export function ReviewResult({ cycle }: { cycle: ReviewCycle }) {
  const status = {
    queued: '等待审核',
    running: '审核中',
    completed: '审核完成',
    failed: '审核失败',
    cancelled: '审核已停止',
  };
  return (
    <div className="review-result">
      <p>
        <strong>{status[cycle.status]}</strong> ·{' '}
        {cycle.trigger === 'manual_submit' ? '人工提交' : '自动审核'}
      </p>
      {cycle.records.map((record) => (
        <div key={record.id}>
          <p>
            <strong>
              {
                { pass: '通过', changes_required: '需要修改', manual_required: '需要人工处理' }[
                  record.outcome
                ]
              }
            </strong>{' '}
            · 事实证据：{record.factualEvidenceSufficient === false ? '不足' : '已检查'}
          </p>
          <div className="review-scores">
            <strong>审核评分</strong>
            {record.scores.length ? (
              <div className="button-row">
                {record.scores.map((score, i) => (
                  <span className="pill" key={i}>
                    {score.name} {score.value}/100 ·{' '}
                    {{ model: '模型', human: '人工', rule: '规则/模拟' }[score.source]}
                  </span>
                ))}
              </div>
            ) : (
              <p className="muted">此审核记录未提供评分。</p>
            )}
          </div>
          <details>
            <summary>检查项</summary>
            <ul>
              {record.checks.map((check, i) => (
                <li key={i}>{check}</li>
              ))}
            </ul>
          </details>
          {!!record.blockingIssues.length && (
            <ul>
              {record.blockingIssues.map((issue) => (
                <li key={issue.id}>
                  <strong>
                    {
                      { factual: '事实证据', deterministic: '基础规则', subjective: '主观质量' }[
                        issue.kind
                      ]
                    }
                    ：
                  </strong>
                  {issue.message}
                </li>
              ))}
            </ul>
          )}
          {!!record.factChecks?.length && (
            <details>
              <summary>事实依据</summary>
              {record.factChecks.map((f, i) => (
                <blockquote key={i}>
                  {f.claim}
                  <p>依据原文：{f.quote}</p>
                </blockquote>
              ))}
            </details>
          )}
          <div className="review-suggestions">
            <strong>修改建议</strong>
            {record.suggestions?.length ? (
              <ul>
                {record.suggestions.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            ) : (
              <p className="muted">本次审核未提出修改建议。</p>
            )}
          </div>
        </div>
      ))}
      {!cycle.records.length && <p className="muted">审核结果尚未生成。</p>}
      {cycle.error && <Notice tone="danger">{cycle.error.message}</Notice>}
    </div>
  );
}

type Draft = { body: string; baseId: string | null; revision: number };
type Pending = { key: string; command: ContentCommand };
export function TaskWorkflow({ detail, onChanged }: { detail: TaskDetail; onChanged: () => void }) {
  const auth = useAuth();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [requirements, setRequirements] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [accepted, setAccepted] = useState<string[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const record = detail.currentReview?.records.at(-1);
  const issues = record?.blockingIssues.filter((i) => !i.resolved) ?? [];
  const subjective =
    issues.length > 0 &&
    issues.every((i) => i.kind === 'subjective') &&
    record?.factualEvidenceSufficient !== false;
  async function send(action: Pending) {
    if (working.current || !auth.session) return;
    working.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    setPending(action);
    try {
      await runContentCommand(detail.task.id, action.command, auth.session.csrfToken, action.key);
      if (action.command.kind === 'saveContent') setDraft(null);
      setPending(null);
      setNotice(
        action.command.kind === 'saveContent'
          ? '人工版本已保存，基础校验已运行；请提交审核。'
          : '操作已保存。',
      );
      onChanged();
    } catch (e) {
      const issue = e instanceof TaskRequestError ? e : null;
      setError(issue?.message ?? '操作失败，请重试确认。');
      if (issue && !issue.uncertain) setPending(null);
      if (issue?.status === 401) void auth.refresh();
      if (issue && [409, 423].includes(issue.status)) onChanged();
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  function submit(command: ContentCommand) {
    void send({ key: crypto.randomUUID(), command });
  }
  function edit(value: TaskDetail) {
    setDraft({
      body: value.currentContent?.body ?? '',
      baseId: value.task.currentContentVersionId,
      revision: value.task.revision,
    });
  }
  async function takeover() {
    if (working.current || !auth.session) return;
    if (detail.workLock?.ownerType === 'manual_review') {
      submit({
        kind: 'stopReview',
        reviewId: detail.workLock.ownerId,
        body: { expectedRevision: detail.task.revision, reason: reason.trim() || '人工接管编辑' },
      });
      return;
    }
    if (!detail.workLock) {
      edit(detail);
      return;
    }
    working.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await runTaskCommand(
        detail.task.id,
        {
          kind: 'stop',
          attemptId: detail.workLock.ownerId,
          body: { expectedRevision: detail.task.revision, reason: reason.trim() || '人工接管编辑' },
        },
        auth.session.csrfToken,
        crypto.randomUUID(),
      );
      edit(result.data);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : '接管失败，请刷新确认。');
      onChanged();
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  async function restart() {
    if (
      !auth.session ||
      working.current ||
      !detail.currentAttempt ||
      !requirements?.trim() ||
      !reason.trim()
    )
      return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      await runTaskCommand(
        detail.task.id,
        {
          kind: 'retry',
          body: {
            expectedRevision: detail.task.revision,
            previousAttemptId: detail.currentAttempt.id,
            restartTerminated: detail.task.lifecycle === 'terminated',
            originalRequest: requirements,
            reason,
          },
        },
        auth.session.csrfToken,
        crypto.randomUUID(),
      );
      setRequirements(null);
      setDraft(null);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : '新执行失败，请刷新确认。');
      onChanged();
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  const disabled = busy || !!pending;
  return (
    <section className="panel detail-panel" aria-labelledby="workflow-title">
      <h2 id="workflow-title">审核与人工处理</h2>
      <p>
        本次自动修改：{detail.currentAttempt?.autoRevisionCount ?? 0} /
        3。人工编辑重审不会恢复自动修改额度。
      </p>
      {detail.currentReview && <ReviewResult cycle={detail.currentReview} />}
      {!detail.currentReview && (
        <p className="muted">
          {detail.currentContent
            ? '当前版本尚无审核结果，请提交当前版本重审。'
            : '尚无文案，请先在“文案执行”中启动生成。'}
        </p>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
      {notice && <Notice tone="success">{notice}</Notice>}
      {pending && (
        <button disabled={busy} onClick={() => void send(pending)}>
          重试确认上次操作
        </button>
      )}
      <h3>人工操作</h3>
      <p className="muted">
        {detail.task.lifecycle !== 'open'
          ? '任务已结束，可查看历史文案和审核。'
          : detail.workLock
            ? '先人工接管并停止当前工作，再编辑文案。'
            : '当前没有运行中的工作，可直接编辑文案。'}
        {detail.task.lifecycle === 'open' && '保存人工版本后，点击“提交当前版本重审”。'}
      </p>
      <div className="button-row">
        {detail.task.lifecycle === 'open' && (
          <button disabled={disabled} onClick={() => void takeover()}>
            {detail.workLock ? '人工接管（停止当前工作）' : '编辑文案'}
          </button>
        )}
        <button
          disabled={disabled || !!draft || !detail.actions.review.allowed}
          onClick={() =>
            submit({
              kind: 'submitReview',
              body: {
                expectedRevision: detail.task.revision,
                contentVersionId: detail.task.currentContentVersionId!,
              },
            })
          }
        >
          提交当前版本重审
        </button>
        <button
          disabled={disabled || !detail.actions.retry.allowed}
          onClick={() => setRequirements(detail.task.originalRequest)}
        >
          调整要求并新执行
        </button>
      </div>
      {draft && (
        <div className="inset">
          <label>
            人工编辑文案
            <textarea
              aria-label="人工编辑文案"
              rows={8}
              maxLength={20000}
              value={draft.body}
              disabled={disabled}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            />
          </label>
          <p className="muted">
            {[...draft.body].length} 字 / 基础校验上限 2000 字；自动刷新不会覆盖此处编辑内容。
          </p>
          {draft.baseId !== detail.task.currentContentVersionId && (
            <Notice tone="warning">
              服务器已有新版本，本地编辑已保留。请核对版本后重新开始编辑。
            </Notice>
          )}
          <div className="button-row">
            <button
              disabled={disabled || !draft.body.trim()}
              onClick={() =>
                submit({
                  kind: 'saveContent',
                  body: {
                    expectedRevision: draft.revision,
                    baseContentVersionId: draft.baseId,
                    body: draft.body,
                  },
                })
              }
            >
              保存人工版本
            </button>
            <button disabled={disabled} onClick={() => setDraft(null)}>
              取消编辑
            </button>
          </div>
        </div>
      )}
      {requirements !== null && (
        <div className="inset">
          <label>
            新执行要求
            <textarea
              aria-label="新执行要求"
              rows={5}
              maxLength={10000}
              value={requirements}
              disabled={disabled}
              onChange={(e) => setRequirements(e.target.value)}
            />
          </label>
          <p className="muted">新建完整执行并保留所有旧版本、审核和修改次数。</p>
          <button
            disabled={disabled || !requirements.trim() || !reason.trim()}
            onClick={() => void restart()}
          >
            保存要求并开始新执行
          </button>
          <button disabled={disabled} onClick={() => setRequirements(null)}>
            取消调整
          </button>
        </div>
      )}
      <label>
        操作／裁决原因
        <input
          aria-label="操作或裁决原因"
          value={reason}
          maxLength={2000}
          disabled={disabled}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      <p className="muted">调整要求并新执行、人工裁决和终止任务均需填写原因。</p>
      {subjective && !detail.workLock && detail.task.lifecycle === 'open' && (
        <fieldset className="review-decision">
          <legend>主观分歧裁决</legend>
          <p>勾选已接受风险、同意放行的问题；未勾选的问题继续保留。</p>
          {issues.map((issue) => (
            <label className="decision-option" key={issue.id}>
              <input
                type="checkbox"
                checked={accepted.includes(issue.id)}
                disabled={disabled}
                onChange={(e) =>
                  setAccepted(
                    e.target.checked
                      ? [...accepted, issue.id]
                      : accepted.filter((id) => id !== issue.id),
                  )
                }
              />
              {issue.message}
            </label>
          ))}
          <button
            disabled={disabled || !reason.trim()}
            onClick={() =>
              submit({
                kind: 'decideReview',
                reviewId: detail.currentReview!.id,
                body: {
                  expectedRevision: detail.task.revision,
                  contentVersionId: detail.task.currentContentVersionId!,
                  reviewRecordId: record!.id,
                  reason,
                  acceptedIssues: issues.filter((i) => accepted.includes(i.id)).map((i) => i.id),
                  unresolvedIssues: issues.filter((i) => !accepted.includes(i.id)).map((i) => i.id),
                  evidenceIds: [],
                },
              })
            }
          >
            记录人工裁决
          </button>
        </fieldset>
      )}
      {(!subjective || !!detail.workLock || detail.task.lifecycle !== 'open') && (
        <div className="review-decision">
          <h3>人工裁决</h3>
          <p className="muted">
            {detail.task.lifecycle !== 'open'
              ? '任务已结束，不能裁决。'
              : detail.workLock
                ? '当前工作进行中，请先人工接管，再处理审核意见。'
                : !record
                  ? '当前版本尚无已完成的审核；审核后才能判断是否需要裁决。'
                  : issues.some((i) => i.kind !== 'subjective') ||
                      record.factualEvidenceSufficient === false
                    ? '事实证据与基础规则阻断必须修改后重审，不能人工裁决放行。'
                    : record.outcome === 'pass'
                      ? '当前审核已通过，无需人工裁决。仅存在主观分歧时才显示裁决操作。'
                      : '当前没有可裁决的主观问题，请编辑文案后重审。'}
          </p>
        </div>
      )}
      <button
        disabled={disabled || !reason.trim() || !detail.actions.terminate.allowed}
        onClick={() =>
          submit({
            kind: 'terminateTask',
            body: { expectedRevision: detail.task.revision, reason },
          })
        }
      >
        终止任务
      </button>
    </section>
  );
}
