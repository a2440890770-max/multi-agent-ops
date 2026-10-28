import { useState } from 'react';
import type { TaskAction } from '@multi-agent-ops/shared';
import { Empty, Notice, PageTitle, PendingButton } from '../components.js';
import {
  approvalLabels,
  executionLabels,
  makePreviewTask,
  publicationLabels,
  sampleBody,
  scenarios,
} from '../preview.js';
import type { Scenario } from '../preview.js';

export function TaskDetailPage({ taskId, search }: { taskId: string; search: string }) {
  const requested = new URLSearchParams(search).get('scenario');
  const initial: Scenario =
    requested && requested in scenarios
      ? (requested as Scenario)
      : taskId === 'task-running'
        ? 'running'
        : taskId === 'task-verification'
          ? 'verification'
          : taskId === 'task-published'
            ? 'published'
            : 'ready';
  const [scene, setScene] = useState<Scenario>(initial);
  const [body, setBody] = useState(sampleBody);
  const [savedBody, setSavedBody] = useState(sampleBody);
  const [notice, setNotice] = useState('');
  const [compare, setCompare] = useState(false);
  const [viewState, setViewState] = useState('success');
  const detail = makePreviewTask(scene, taskId);
  const dirty = body !== savedBody;
  const invoke = (action: TaskAction) => {
    if (action === 'save') {
      setSavedBody(body);
      setScene('draft');
      setNotice('预览：新版本已保存，需要提交审核。此示例未写入服务器。');
    } else if (action === 'approve') {
      setScene('approved');
      setNotice('预览：已批准当前版本，等待点击发布。');
    } else if (action === 'stop') {
      setScene('stopping');
      setNotice('预览：已请求停止；确认停止前继续锁定编辑。');
    } else setNotice('已展示操作入口。业务接口待接入，本次未提交请求或改变业务记录。');
  };
  const actionButton = (action: TaskAction, label: string, primary = false) => {
    const availability = detail.actions[action];
    const unsavedBlock =
      dirty && ['review', 'approve', 'publish', 'retry_publish'].includes(action);
    return (
      <button
        className={primary ? 'primary' : ''}
        disabled={
          viewState !== 'success' ||
          !availability.allowed ||
          unsavedBlock ||
          (action === 'save' && (scene === 'conflict' || !body.trim()))
        }
        title={
          unsavedBlock
            ? '有未保存输入，请先保存新版本并提交审核'
            : (availability.reason ?? undefined)
        }
        onClick={() => invoke(action)}
      >
        {label}
      </button>
    );
  };
  return (
    <>
      <div className="back-row">
        <a className="text-link" href="/tasks">
          ← 返回任务列表
        </a>
        <div className="scenario-controls">
          <label>
            预览场景
            <select
              aria-label="预览场景"
              value={scene}
              onChange={(e) => {
                setScene(e.target.value as Scenario);
                setNotice('');
              }}
            >
              {Object.entries(scenarios).map(([key, label]) => (
                <option value={key} key={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            页面状态
            <select
              aria-label="页面状态"
              value={viewState}
              onChange={(e) => setViewState(e.target.value)}
            >
              <option value="success">正常</option>
              <option value="loading">加载中</option>
              <option value="empty">无数据</option>
              <option value="error">加载失败</option>
              <option value="forbidden">无权限</option>
            </select>
          </label>
        </div>
      </div>
      <PageTitle
        eyebrow={`TASK / ${taskId}`}
        title="秋日灵感计划"
        description="品牌日常文案 · 运营成员创建 · 今天 15:30"
      >
        <div className="button-row">
          {actionButton('copy', '复制为新任务')}
          {actionButton('retry', '重新执行')}
          {actionButton('terminate', '终止任务')}
        </div>
      </PageTitle>
      {viewState === 'loading' ? (
        <div className="skeleton" role="status">
          正在加载任务、版本和操作资格…
        </div>
      ) : viewState === 'empty' ? (
        <Empty title="任务不存在或已不可访问" />
      ) : viewState === 'error' ? (
        <Notice tone="danger">
          任务加载失败，未修改任何内容。
          <button onClick={() => setViewState('success')}>重新加载预览</button>
        </Notice>
      ) : viewState === 'forbidden' ? (
        <Notice tone="danger">无权限查看此任务。请使用有效团队成员身份。</Notice>
      ) : (
        <>
          <div className="status-strip">
            {[
              ['执行', detail.execution ? executionLabels[detail.execution] : '尚未执行'],
              ['审批', approvalLabels[detail.approval]],
              ['发布', publicationLabels[detail.publication]],
              ['复盘', '未触发'],
            ].map(([label, value]) => (
              <div key={label}>
                <small>{label}</small>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
          {scene === 'stopping' && (
            <Notice tone="warning">
              已请求停止，正在确认工作已结束。编辑继续锁定；等待服务端确认停止或隔离旧执行器。
            </Notice>
          )}
          {scene === 'verification' && (
            <Notice tone="danger">
              发送结果未知，发布待核实。请核实原发送结果；编辑、重新执行及重复发布均已锁定。
              <a href="#publication">前往核实 →</a>
            </Notice>
          )}
          {scene === 'published' && (
            <Notice tone="success">
              此任务已发布，原任务只读。如需再创作或再次发布，请复制为新任务并重新审核、批准。
            </Notice>
          )}
          {notice && <Notice tone="success">{notice}</Notice>}
          <nav className="anchor-tabs" aria-label="任务详情分区">
            <a href="#content">内容与版本</a>
            <a href="#publication">审核与发布</a>
            <a href="#reflection">复盘与证据</a>
          </nav>
          <div className="content-grid task-grid">
            <div>
              <section className="panel" id="content">
                <div className="panel-heading">
                  <h2>当前文案</h2>
                  <span className="pill">V{detail.currentContent?.versionNo} · 人工编辑</span>
                </div>
                <div className="editor-meta">
                  <span>品牌官方微博</span>
                  <span>
                    {detail.actions.save.allowed ? '可编辑' : '只读'} · 未保存输入留在本页
                  </span>
                </div>
                <textarea
                  className="content-editor"
                  aria-label="当前文案"
                  value={body}
                  readOnly={!detail.actions.save.allowed}
                  onChange={(e) => setBody(e.target.value)}
                  maxLength={20000}
                />
                <div className="editor-footer">
                  <small>{body.length} 字符 · 格式限制以账号规则校验为准</small>
                  {actionButton('save', '保存新版本', true)}
                </div>
                {!detail.actions.save.allowed && (
                  <p className="disabled-reason">{detail.actions.save.reason}</p>
                )}
                {dirty && (
                  <Notice tone="warning">
                    有未保存输入。保存后原审核及批准失效，需要重新提交审核。
                  </Notice>
                )}
                {scene === 'draft' && <Notice>新版本已保存，需要提交审核。</Notice>}
                {scene === 'conflict' && (
                  <div className="conflict-box">
                    <Notice tone="danger">
                      保存冲突：服务器已有更新版本。你的输入已保留，未覆盖任何内容。
                    </Notice>
                    <p>编辑依据：V3 / 并发号 12；服务器：V4 / 并发号 13。</p>
                    <button onClick={() => setCompare(!compare)}>
                      {compare ? '收起比较' : '查看最新版本并比较'}
                    </button>
                    {compare && (
                      <div className="compare-grid">
                        <div>
                          <h3>我的未保存输入</h3>
                          <pre>{body}</pre>
                        </div>
                        <div>
                          <h3>服务器最新版本 V4</h3>
                          <pre>{sampleBody + '\n一起，发现日常的新可能。'}</pre>
                        </div>
                        <Notice>比较后需明确选择如何合并并重新保存。此处不自动覆盖输入。</Notice>
                      </div>
                    )}
                  </div>
                )}
              </section>
              <section className="panel" id="publication">
                <div className="panel-heading">
                  <h2>审核与发布</h2>
                  <span>逐步确认</span>
                </div>
                <ol className="approval-steps">
                  <li className={scene !== 'draft' ? 'done' : ''}>01 保存版本</li>
                  <li
                    className={
                      detail.approval === 'pending' || detail.approval === 'approved' ? 'done' : ''
                    }
                  >
                    02 提交审核
                  </li>
                  <li className={detail.approval === 'approved' ? 'done' : ''}>03 人工批准</li>
                  <li className={scene === 'published' ? 'done' : ''}>04 点击发布</li>
                </ol>
                <div className="detail-panel">
                  <h3>
                    {scene === 'blocked'
                      ? '审核未通过 · 有确定性阻断'
                      : detail.currentReview?.status === 'running'
                        ? '审核进行中'
                        : detail.approval === 'pending' || detail.approval === 'approved'
                          ? '当前版本审核通过'
                          : '当前版本需要提交审核'}
                  </h3>
                  <p className="muted">
                    审核结论绑定具体版本。保存不会自动审核，批准不会自动发送。
                  </p>
                  {scene === 'blocked' && (
                    <Notice tone="danger">
                      平台格式规则未满足。人工裁决不能绕过该阻断，请修改文案后重新审核。
                    </Notice>
                  )}
                  {detail.currentReview?.records[0]?.scores.map((score) => (
                    <span className="pill" key={score.name}>
                      {score.name} {score.value}/5 · 模型评分
                    </span>
                  ))}
                  <div className="button-row">
                    {actionButton('review', '提交审核')}
                    {actionButton('approve', '批准当前版本')}
                    {actionButton('publish', '人工发布交接', true)}
                  </div>
                  {dirty && <p className="disabled-reason">先保存当前输入，再重新提交审核。</p>}
                  {!detail.actions.approve.allowed && (
                    <p className="disabled-reason">批准：{detail.actions.approve.reason}</p>
                  )}
                  {!detail.actions.publish.allowed && (
                    <p className="disabled-reason">发布：{detail.actions.publish.reason}</p>
                  )}
                  <p className="muted small">官方发布授权未配置；官方 API 发布入口暂不可用。</p>
                  {['manual', 'verification', 'failed'].includes(scene) && (
                    <div className="inset">
                      <h3>
                        {scene === 'manual'
                          ? '人工交接 · 冻结批准版本'
                          : scene === 'failed'
                            ? '已明确确认未发布'
                            : '核实原发送结果'}
                      </h3>
                      <p className="mono">operation-demo / dispatch-1 · V3</p>
                      {scene === 'failed' ? (
                        <>
                          {actionButton('retry_publish', '明确失败后重试')}
                          <p className="muted">重试仍复用原操作，重新校验批准并新增发送记录。</p>
                        </>
                      ) : (
                        <>
                          <label>
                            核实结论
                            <select>
                              <option>仍不确定 · 保持锁定</option>
                              <option>确认已发布且匹配批准版本</option>
                              <option>确认未发布，且前次不会再生效</option>
                            </select>
                          </label>
                          <label>
                            平台内容 ID / 链接
                            <input type="url" placeholder="填写实际账号下的发布链接" />
                          </label>
                          <label>
                            证据与差异说明
                            <textarea
                              rows={3}
                              placeholder="记录账号、实际内容、核实方法和证据。差异未解决继续待核实。"
                            />
                          </label>
                          <PendingButton>
                            {scene === 'manual' ? '提交人工回填' : '提交核实记录'}
                          </PendingButton>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </section>
              <section className="panel" id="reflection">
                <div className="panel-heading">
                  <h2>复盘与证据</h2>
                  {actionButton('reflect', '手动触发复盘')}
                </div>
                <div className="detail-panel">
                  <Notice>复盘不改变发布结果，也不自动启用正式策略。</Notice>
                  <div className="reflection-grid">
                    <div>
                      <h3>证据与观察</h3>
                      <p>执行记录、内容版本、审核及发布事实。</p>
                    </div>
                    <div>
                      <h3>假设与替代解释</h3>
                      <p>结论可能受样本、语气及发布时间影响。</p>
                    </div>
                    <div>
                      <h3>建议与不确定性</h3>
                      <p>设计对照验证；没有运营指标时不推断效果。</p>
                    </div>
                  </div>
                  <PendingButton>保存建议为候选经验</PendingButton>
                  <p className="muted small">以上为信息布局示例，尚未生成该任务的复盘记录。</p>
                </div>
              </section>
            </div>
            <aside className="task-aside">
              <section className="panel detail-panel">
                <h2>执行进度</h2>
                <p className="muted">尝试 #1 · 自动修改 2 / 3 轮</p>
                <ol className="timeline">
                  {['理解与分派', '资料研究', '文案生成', '审核与修改'].map((step, i) => (
                    <li key={step} className={detail.workLock && i > 1 ? 'waiting' : ''}>
                      <span>{i + 1}</span>
                      <div>
                        <strong>{step}</strong>
                        <small>
                          {detail.workLock
                            ? i === 1
                              ? '进行中'
                              : i < 1
                                ? '已完成'
                                : '等待中'
                            : '已完成'}
                        </small>
                      </div>
                    </li>
                  ))}
                </ol>
                {actionButton('stop', '停止本次执行')}
                {scene === 'reviewing' && <PendingButton>停止人工审核</PendingButton>}
                <p className="muted small">停止执行用于人工编辑；终止任务会阻止后续发布。</p>
              </section>
              <section className="panel detail-panel">
                <h2>版本历史</h2>
                {[3, 2, 1].map((v) => (
                  <div className="version-row" key={v}>
                    <span className="version-icon">V{v}</span>
                    <div>
                      <strong>{v === 3 ? '人工编辑' : v === 2 ? '自动修改' : '初稿'}</strong>
                      <small>
                        {v === 3 ? '当前版本' : '历史保留'} · 今天 15:{v === 3 ? '30' : '20'}
                      </small>
                    </div>
                  </div>
                ))}
                <button
                  onClick={() => {
                    setCompare(!compare);
                    setScene('conflict');
                  }}
                >
                  预览版本比较
                </button>
              </section>
              <details className="panel detail-panel">
                <summary>任务要求与追踪</summary>
                <p>{detail.task.originalRequest}</p>
                <dl>
                  <dt>配置版本</dt>
                  <dd>V4</dd>
                  <dt>内容来源</dt>
                  <dd>人工编辑 / 尝试 #1</dd>
                  <dt>业务并发号</dt>
                  <dd>{detail.task.revision}</dd>
                </dl>
                <button disabled>Langfuse 详情待接入 ↗</button>
              </details>
            </aside>
          </div>
        </>
      )}
    </>
  );
}
