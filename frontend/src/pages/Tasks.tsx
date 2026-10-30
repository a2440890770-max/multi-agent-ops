import { useEffect, useState } from 'react';
import type { OperationQueries, TaskSummary } from '@multi-agent-ops/shared';
import { Empty, Notice, PageTitle } from '../components.js';
import { useAuth } from '../auth.js';
import { getTasks, TaskRequestError } from '../task-api.js';
import { approvalLabels, executionLabels, publicationLabels } from '../task-labels.js';

const filters: { value: string; label: string; query: OperationQueries['listTasks'] }[] = [
  { value: 'all', label: '全部任务', query: {} },
  {
    value: 'awaiting_clarification',
    label: '待澄清',
    query: { execution: 'awaiting_clarification' },
  },
  { value: 'queued', label: '排队中', query: { execution: 'queued' } },
  { value: 'manual_required', label: '待人工处理', query: { execution: 'manual_required' } },
  { value: 'cancelled', label: '已取消', query: { execution: 'cancelled' } },
  { value: 'running', label: '执行中', query: { execution: 'running' } },
  { value: 'ready', label: '产出就绪', query: { execution: 'ready' } },
  { value: 'failed', label: '执行失败', query: { execution: 'failed' } },
  { value: 'pending', label: '待批准', query: { approval: 'pending' } },
  {
    value: 'verification_required',
    label: '待核实',
    query: { publication: 'verification_required' },
  },
  { value: 'published', label: '已发布', query: { publication: 'published' } },
];

export function Tasks() {
  const { session, refresh } = useAuth();
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [revision, setRevision] = useState(0);
  const [cursor, setCursor] = useState<string | undefined>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [items, setItems] = useState<TaskSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (search.trim() === query) return;
    const timer = window.setTimeout(() => {
      setQuery(search.trim());
      setCursor(undefined);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search, query]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    if (!cursor) {
      setItems([]);
      setNextCursor(null);
    }
    void getTasks(
      {
        ...filters.find((f) => f.value === filter)!.query,
        ...(query ? { q: query } : {}),
        limit: 20,
        ...(cursor ? { cursor } : {}),
      },
      controller.signal,
    )
      .then((page) => {
        if (controller.signal.aborted) return;
        setItems((previous) =>
          cursor
            ? [
                ...previous,
                ...page.items.filter(
                  (item) => !previous.some((old) => old.task.id === item.task.id),
                ),
              ]
            : page.items,
        );
        setNextCursor(page.nextCursor);
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        setError(failure instanceof Error ? failure.message : '任务列表加载失败，请重试。');
        if (failure instanceof TaskRequestError && failure.status === 401) void refresh();
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [filter, query, cursor, revision, refresh]);
  const reload = () => {
    setCursor(undefined);
    setRevision((v) => v + 1);
  };
  return (
    <>
      <PageTitle
        eyebrow="TASK WORKSPACE"
        title="每一个想法，都有迹可循"
        description="查看当前团队已保存的任务，确认状态与下一步。"
      >
        <div className="button-row">
          <button onClick={reload}>刷新列表</button>
          <a className="button primary" href="/tasks/new">
            ＋ 创建任务
          </a>
        </div>
      </PageTitle>
      <section className="panel" aria-label="任务列表" aria-busy={loading}>
        <div className="panel-toolbar">
          <div className="tab-row" aria-label="任务筛选">
            {filters.map((f) => (
              <button
                key={f.value}
                className={filter === f.value ? 'selected' : ''}
                aria-pressed={filter === f.value}
                onClick={() => {
                  setFilter(f.value);
                  setCursor(undefined);
                }}
              >
                {f.label}
              </button>
            ))}
          </div>
          <input
            aria-label="搜索任务"
            placeholder="搜索标题或任务编号"
            maxLength={120}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {error && (
          <>
            <Notice tone="danger">{error}</Notice>
            <button onClick={() => setRevision((v) => v + 1)}>重新加载</button>
          </>
        )}
        {loading && <Notice>正在加载任务列表…</Notice>}
        {!!items.length && (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>任务 / 创建人</th>
                  <th>执行状态</th>
                  <th>审批状态</th>
                  <th>发布状态</th>
                  <th>更新时间</th>
                  <th>
                    <span className="sr-only">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.task.id}>
                    <td>
                      <a className="task-link" href={`/tasks/${encodeURIComponent(item.task.id)}`}>
                        {item.task.title}
                      </a>
                      <small>{item.task.id}</small>
                      <small>
                        创建人：
                        {item.task.createdBy === session?.member.id
                          ? session.member.displayName
                          : item.task.createdBy}
                      </small>
                    </td>
                    <td>
                      <span className={`pill ${item.execution === 'running' ? 'blue' : ''}`}>
                        {item.execution
                          ? (executionLabels[item.execution] ?? '未知状态')
                          : '尚未执行'}
                      </span>
                      {item.currentStep && <small>{item.currentStep}</small>}
                    </td>
                    <td>{approvalLabels[item.approval] ?? '未知状态'}</td>
                    <td>
                      <span className={`pill ${item.publication === 'published' ? 'green' : ''}`}>
                        {publicationLabels[item.publication] ?? '未知状态'}
                      </span>
                    </td>
                    <td>
                      {new Date(item.task.updatedAt).toLocaleString('zh-CN', { hour12: false })}
                    </td>
                    <td>
                      <a className="text-link" href={`/tasks/${encodeURIComponent(item.task.id)}`}>
                        查看 →
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!loading && !error && !items.length && (
          <Empty title="没有符合条件的任务">调整筛选条件，或创建一项新任务。</Empty>
        )}
        {!!items.length && (
          <div className="panel-heading">
            <span>已加载 {items.length} 项任务</span>
            {nextCursor && (
              <button disabled={loading || !!error} onClick={() => setCursor(nextCursor)}>
                加载更多
              </button>
            )}
          </div>
        )}
      </section>
      <p className="page-note">
        仅显示当前团队的任务，按更新时间从新到旧排列。新建任务保存后为“尚未执行”。
      </p>
    </>
  );
}
