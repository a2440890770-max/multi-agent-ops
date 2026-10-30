import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { OperationBodies } from '@multi-agent-ops/shared';
import { useAuth } from '../auth.js';
import { Notice, PageTitle } from '../components.js';
import { navigate } from '../navigation.js';
import { createTask, TaskRequestError } from '../task-api.js';
import { clearDraft, draftKey, readDraft, saveDraft } from '../task-draft.js';
import type { TaskDraft } from '../task-draft.js';

export function CreateTask() {
  const auth = useAuth();
  const member = auth.session!.member;
  const storageKey = draftKey(member.teamId, member.id);
  const [draft, setDraft] = useState(() => readDraft(storageKey));
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const busy = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const retryExpired =
    !!draft.pending && Date.now() - draft.pending.startedAt >= 23 * 60 * 60 * 1000;
  const locked = submitting || !!draft.pending;
  const change = (
    field: 'title' | 'originalRequest' | 'referenceLabel' | 'referenceUrl',
    value: string,
  ) => {
    const next = { ...draft, [field]: value };
    setDraft(next);
    saveDraft(storageKey, next);
    setMessage('');
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy.current) return;
    if (draft.pending && Date.now() - draft.pending.startedAt >= 23 * 60 * 60 * 1000) {
      setMessage('这次提交已超过可直接重试的时限，请联系管理员核实创建结果。');
      return;
    }
    if (!draft.pending && (!draft.title.trim() || !draft.originalRequest.trim())) {
      setMessage('请填写任务标题和主题与目标，不能只输入空白。');
      return;
    }
    const referenceUrl = draft.referenceUrl.trim();
    if (!draft.pending && draft.referenceLabel.trim() && !referenceUrl) {
      setMessage('填写参考资料名称时，请同时提供链接。');
      return;
    }
    if (!draft.pending && referenceUrl) {
      try {
        if (!['http:', 'https:'].includes(new URL(referenceUrl).protocol)) throw new Error();
      } catch {
        setMessage('请填写有效的 HTTP 或 HTTPS 参考资料链接。');
        return;
      }
    }
    const body: OperationBodies['createTask'] = {
      title: draft.title,
      originalRequest: draft.originalRequest,
      ...(referenceUrl
        ? {
            referenceInputs: [
              {
                label: draft.referenceLabel.trim() ? draft.referenceLabel : '参考资料',
                url: referenceUrl,
              },
            ],
          }
        : {}),
    };
    const pending = draft.pending ?? { key: crypto.randomUUID(), body, startedAt: Date.now() };
    const nextDraft: TaskDraft = { ...draft, pending };
    busy.current = true;
    setSubmitting(true);
    setMessage('');
    setDraft(nextDraft);
    saveDraft(storageKey, nextDraft);
    try {
      const result = await createTask(pending.body, auth.session!.csrfToken, pending.key);
      clearDraft(storageKey);
      if (active.current) navigate(`/tasks/${encodeURIComponent(result.data.task.id)}`, true);
    } catch (error) {
      const uncertain = error instanceof TaskRequestError && error.uncertain;
      const retained = { ...nextDraft, pending: uncertain ? pending : null };
      saveDraft(storageKey, retained);
      if (active.current) {
        setDraft(retained);
        setMessage(error instanceof Error ? error.message : '创建任务失败，请重试。');
        if (error instanceof TaskRequestError && [401, 403].includes(error.status))
          await auth.refresh();
      }
    } finally {
      busy.current = false;
      if (active.current) setSubmitting(false);
    }
  };
  return (
    <>
      <PageTitle
        eyebrow="NEW TASK"
        title="从一个明确的目标开始"
        description="保存原始要求和参考资料，创建后可在详情页查看。"
      />
      <form className="panel form-panel" onSubmit={submit} aria-busy={submitting}>
        <label>
          任务标题 <span>必填</span>
          <input
            name="title"
            required
            maxLength={120}
            value={draft.title}
            onChange={(e) => change('title', e.target.value)}
            disabled={locked}
            placeholder="例如：新品介绍文案"
          />
        </label>
        <label>
          主题与目标 <span>必填</span>
          <textarea
            name="originalRequest"
            required
            maxLength={10000}
            rows={7}
            value={draft.originalRequest}
            onChange={(e) => change('originalRequest', e.target.value)}
            disabled={locked}
            placeholder="想说什么、面向谁、必须满足什么？"
          />
        </label>
        <label>
          参考资料名称 <span>选填</span>
          <input
            name="referenceLabel"
            maxLength={200}
            value={draft.referenceLabel}
            onChange={(e) => change('referenceLabel', e.target.value)}
            disabled={locked}
            placeholder="例如：产品说明"
          />
        </label>
        <label>
          参考资料链接 <span>选填</span>
          <input
            name="referenceUrl"
            type="url"
            maxLength={2048}
            value={draft.referenceUrl}
            onChange={(e) => change('referenceUrl', e.target.value)}
            disabled={locked}
            placeholder="https://"
          />
        </label>
        <div className="inset">
          <strong>微博运营账号可稍后绑定</strong>
          <p>已有团队账号时自动绑定；未配置时可先保存任务。创建不会自动生成或发布内容。</p>
        </div>
        {draft.pending && !submitting && (
          <Notice tone="warning">
            {retryExpired
              ? '这次提交已超过可直接重试的时限，请联系管理员核实是否已创建任务。'
              : '本次创建结果尚未确认，输入已保留。请点击“重试确认本次提交”，避免重复创建。'}
          </Notice>
        )}
        {message && <Notice tone="danger">{message}</Notice>}
        <div className="button-row">
          <button className="primary" type="submit" disabled={submitting || retryExpired}>
            {submitting ? '正在创建…' : draft.pending ? '重试确认本次提交' : '创建任务'}
          </button>
          <button type="button" disabled={submitting} onClick={() => navigate('/tasks')}>
            返回任务列表
          </button>
        </div>
        <p className="muted small">
          尚未提交的输入仅暂存在当前标签页，并按团队和成员区分；创建成功后自动清除。
        </p>
      </form>
    </>
  );
}
