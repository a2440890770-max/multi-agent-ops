import { useEffect, useState } from 'react';
import type { TaskDetail } from '@multi-agent-ops/shared';
import { Notice, PageTitle } from '../components.js';
import { useAuth } from '../auth.js';
import { getTaskDetail, TaskRequestError } from '../task-api.js';
import { approvalLabels, executionLabels, publicationLabels } from '../task-labels.js';
import { TaskExecutionControls, TaskExecutionHistory } from './TaskExecution.js';
import { TaskClarifications } from './TaskClarifications.js';

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; detail: TaskDetail }
  | { status: 'error'; error: TaskRequestError };
const date = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false });
function safeLink(value: string | null) {
  try {
    return value && ['http:', 'https:'].includes(new URL(value).protocol) ? value : null;
  } catch {
    return null;
  }
}

export function TaskDetailPage({ taskId }: { taskId: string }) {
  const { refresh } = useAuth();
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState((previous) => (previous.status === 'ready' ? previous : { status: 'loading' }));
    void getTaskDetail(taskId, controller.signal)
      .then((detail) => {
        if (!controller.signal.aborted) setState({ status: 'ready', detail });
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        const error =
          failure instanceof TaskRequestError
            ? failure
            : new TaskRequestError(503, 'REQUEST_FAILED', '任务加载失败，请稍后重试。');
        setState({ status: 'error', error });
        if (error.status === 401) void refresh();
      });
    return () => controller.abort();
  }, [taskId, revision, refresh]);
  const reload = () => setRevision((value) => value + 1);
  useEffect(() => {
    if (state.status !== 'ready' || !['queued', 'running'].includes(state.detail.execution ?? ''))
      return;
    const timer = window.setTimeout(() => setRevision((value) => value + 1), 1500);
    return () => window.clearTimeout(timer);
  }, [state]);
  const back = (
    <div className="back-row">
      <a className="text-link" href="/tasks">
        ← 返回任务列表
      </a>
      <a className="text-link" href="/tasks/new">
        创建新任务 →
      </a>
    </div>
  );
  if (state.status === 'loading')
    return (
      <>
        {back}
        <PageTitle eyebrow="TASK DETAIL" title="任务详情" description="正在读取已保存的任务。" />
        <section className="panel detail-panel" aria-busy="true">
          <Notice>正在加载任务详情…</Notice>
        </section>
      </>
    );
  if (state.status === 'error') {
    const { error } = state;
    const title =
      error.status === 404
        ? '任务不存在或无权查看'
        : error.status === 403
          ? '无权查看此任务'
          : error.status === 409
            ? '任务信息需要核对'
            : '任务加载失败';
    return (
      <>
        {back}
        <PageTitle
          eyebrow="TASK DETAIL"
          title={title}
          description="请确认任务链接和当前登录身份。"
        />
        <section className="panel detail-panel">
          <Notice tone="danger">{error.message}</Notice>
          <div className="button-row">
            <button onClick={reload}>重新加载</button>
            {[401, 403].includes(error.status) && (
              <button
                onClick={() => {
                  void refresh();
                }}
              >
                重新检查登录状态
              </button>
            )}
          </div>
        </section>
      </>
    );
  }
  const { detail } = state;
  const { task } = detail;
  return (
    <>
      {back}
      <PageTitle
        eyebrow="TASK DETAIL"
        title={task.title}
        description={`创建于 ${date(task.createdAt)} · 更新于 ${date(task.updatedAt)}`}
      >
        <button onClick={reload}>刷新详情</button>
      </PageTitle>
      <div className="status-strip">
        {[
          [
            '执行状态',
            detail.execution ? (executionLabels[detail.execution] ?? '未知状态') : '尚未执行',
          ],
          ['审批状态', approvalLabels[detail.approval] ?? '未知状态'],
          ['发布状态', publicationLabels[detail.publication] ?? '未知状态'],
          ['微博运营账号', detail.account?.displayName ?? '未绑定'],
        ].map(([label, value]) => (
          <div key={label}>
            <small>{label}</small>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <div className="content-grid task-grid">
        <div>
          <section className="panel detail-panel" aria-labelledby="original-request-title">
            <h2 id="original-request-title">原始要求</h2>
            <div className="task-original" data-testid="original-request">
              {task.originalRequest}
            </div>
          </section>
          <section className="panel detail-panel" aria-labelledby="references-title">
            <h2 id="references-title">参考资料</h2>
            {task.referenceInputs.length ? (
              <ul className="task-references">
                {task.referenceInputs.map((source) => (
                  <li key={source.id}>
                    <strong>{source.label}</strong>
                    {safeLink(source.url) ? (
                      <a href={safeLink(source.url)!} target="_blank" rel="noopener noreferrer">
                        {source.url}
                      </a>
                    ) : (
                      <span>{source.url ?? '未提供链接'}</span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">未提供参考资料。</p>
            )}
          </section>
          <section className="panel detail-panel" aria-labelledby="progress-title">
            <h2 id="progress-title">执行进度</h2>
            <p>
              <strong>当前步骤：</strong>
              {detail.currentStep ?? '尚未开始'}
            </p>
            {detail.errorMessage ? (
              <Notice tone="danger">{detail.errorMessage}</Notice>
            ) : (
              <p className="muted">暂无错误信息。</p>
            )}
            {detail.currentAttempt?.executorMode === 'mock' && (
              <p className="muted">当前为模拟执行，进度和步骤已保存至数据库。</p>
            )}
          </section>
          {detail.currentContent && (
            <section className="panel detail-panel">
              <h2>模拟产出</h2>
              <Notice tone="warning">仅用于流程验证，不代表真实研究或审核结果。</Notice>
              <div className="task-original" data-testid="mock-output">
                {detail.currentContent.body}
              </div>
            </section>
          )}
          <TaskClarifications
            key={task.currentAttemptId ?? 'none'}
            detail={detail}
            onChanged={reload}
          />
          <TaskExecutionHistory taskId={task.id} revision={task.revision} />
        </div>
        <aside>
          <TaskExecutionControls detail={detail} onChanged={reload} />
          <section className="panel detail-panel" aria-labelledby="task-info-title">
            <h2 id="task-info-title">任务信息</h2>
            <dl className="task-metadata">
              <dt>任务编号</dt>
              <dd data-testid="task-id">{task.id}</dd>
              <dt>创建人 ID</dt>
              <dd data-testid="creator-id">{task.createdBy}</dd>
              <dt>所属团队 ID</dt>
              <dd data-testid="team-id">{task.teamId}</dd>
              <dt>任务状态</dt>
              <dd>{{ open: '开放', terminated: '已终止', published: '已发布' }[task.lifecycle]}</dd>
              <dt>任务版本</dt>
              <dd>{task.revision}</dd>
            </dl>
          </section>
          <section className="panel detail-panel">
            <h2>微博运营账号</h2>
            {detail.account ? (
              <>
                <p>{detail.account.displayName}</p>
                <p className="muted">
                  授权状态：
                  {
                    { valid: '有效', expired: '已过期', unconfigured: '未配置' }[
                      detail.account.authorizationStatus
                    ]
                  }
                </p>
              </>
            ) : (
              <p className="muted">未绑定，可在后续账号绑定功能接入后关联。</p>
            )}
          </section>
          <section className="panel detail-panel">
            <h2>后续操作</h2>
            <p className="muted">真实模型执行、审核和发布功能尚未接入。</p>
            <div className="button-row">
              <button disabled>发布内容</button>
            </div>
          </section>
        </aside>
      </div>
    </>
  );
}
