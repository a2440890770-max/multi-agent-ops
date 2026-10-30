import { useState } from 'react';
import type { Role } from '@multi-agent-ops/shared';
import { Empty, Notice, PageTitle, PendingButton } from '../components.js';

const memories = [
  {
    id: 'memory-1',
    label: '账号偏好',
    type: 'account_preference',
    body: '表达自然、克制，避免没有依据的效果承诺。',
    status: 'active',
    state: '使用中',
    source: '成员明确偏好',
    sync: '同步完成',
  },
  {
    id: 'memory-2',
    label: '候选经验',
    type: 'candidate',
    body: '提问式结尾可能提升参与意愿，建议使用固定样本验证。',
    status: 'active',
    state: '候选 · 待验证',
    source: '复盘 · task-demo / V3',
    sync: '同步完成',
  },
  {
    id: 'memory-3',
    label: '任务事实',
    type: 'task_fact',
    body: null,
    status: 'deleted',
    state: '已删除 · 禁止召回',
    source: '历史任务记录',
    sync: '清理失败 · 索引服务不可用',
  },
];
export function Memories() {
  const [type, setType] = useState('all');
  const [status, setStatus] = useState('all');
  const [purpose, setPurpose] = useState('management');
  const [selected, setSelected] = useState('memory-2');
  const visible = memories.filter(
    (m) =>
      (type === 'all' || m.type === type) &&
      (status === 'all' || m.status === status) &&
      (purpose !== 'creation' || (m.type !== 'candidate' && m.status === 'active')) &&
      (purpose === 'management' || m.status === 'active'),
  );
  const item = visible.find((m) => m.id === selected) ?? visible[0];
  return (
    <>
      <PageTitle
        eyebrow="MEMORY LIBRARY"
        title="让经验有来源，也有边界"
        description="偏好、事实和候选分别管理。候选经验只用于复盘或实验，人工确认后才能在适用范围内使用。"
      />
      {purpose === 'creation' &&
        (type === 'candidate' || (status !== 'all' && status !== 'active')) && (
          <Notice tone="warning">
            筛选用途不相容：正式创作仅允许未禁用、未删除的非候选记忆。业务接口将返回
            422，请调整条件。
          </Notice>
        )}
      <div className="filter-row">
        <label>
          类型
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="all">全部类型</option>
            <option value="account_preference">账号偏好</option>
            <option value="task_fact">任务事实</option>
            <option value="candidate">候选经验</option>
            <option value="confirmed_experience">已确认经验</option>
          </select>
        </label>
        <label>
          状态
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="all">全部状态</option>
            <option value="active">未禁用</option>
            <option value="disabled">已禁用</option>
            <option value="deleted">已删除</option>
          </select>
        </label>
        <label>
          用途
          <select value={purpose} onChange={(e) => setPurpose(e.target.value)}>
            <option value="management">人工管理</option>
            <option value="creation">正式创作召回</option>
            <option value="reflection">复盘</option>
            <option value="experiment">实验</option>
          </select>
        </label>
      </div>
      <div className="content-grid">
        <section className="panel">
          <div className="panel-heading">
            <h2>业务记忆</h2>
            <span>{visible.length} 条示例</span>
          </div>
          {visible.map((m) => (
            <button
              key={m.id}
              className={`memory-row ${item?.id === m.id ? 'selected' : ''}`}
              onClick={() => setSelected(m.id)}
            >
              <span className="pill">{m.label}</span>
              <strong>{m.body ?? '正文已删除'}</strong>
              <small>
                {m.state} · {m.source}
              </small>
            </button>
          ))}
          {!visible.length && <Empty title="没有符合条件的记忆" />}
        </section>
        <section className="panel detail-panel">
          <h2>来源与治理</h2>
          {item ? (
            <>
              <p>{item.body ?? '删除后仅保留必要标记与审计，正文不再展示。'}</p>
              <dl>
                <dt>类型</dt>
                <dd>{item.label}</dd>
                <dt>来源</dt>
                <dd>{item.source}</dd>
                <dt>业务版本</dt>
                <dd>V{item.status === 'deleted' ? '2' : '1'}</dd>
                <dt>同步 / 清理</dt>
                <dd>{item.sync}</dd>
              </dl>
              {item.status === 'deleted' ? (
                <>
                  <Notice tone="danger">已立即停止召回；受管索引清理失败，尚未全部清除。</Notice>
                  <PendingButton>重试清理</PendingButton>
                </>
              ) : (
                <>
                  <div className="button-row">
                    <PendingButton>编辑</PendingButton>
                    <PendingButton>禁用</PendingButton>
                    <PendingButton>删除</PendingButton>
                  </div>
                  {item.type === 'candidate' && (
                    <>
                      <Notice tone="warning">
                        该建议仍有不确定性：没有对照样本，不能推断运营效果。
                      </Notice>
                      <label>
                        确认依据与适用范围
                        <textarea rows={3} placeholder="人工确认需要证据及明确范围" />
                      </label>
                      <PendingButton>确认候选经验</PendingButton>
                    </>
                  )}
                </>
              )}
            </>
          ) : (
            <p className="muted">请选择一条记忆。</p>
          )}
        </section>
      </div>
      <p className="page-note">
        删除无回收站。删除确认框须说明立即停止召回、后台清理范围，以及清理失败时的处理入口。
      </p>
    </>
  );
}

export function Evaluations({ blind = false }: { blind?: boolean }) {
  const [score, setScore] = useState('');
  return (
    <>
      <PageTitle
        eyebrow="EVALUATION LAB"
        title={blind ? '只看内容，独立判断' : '用对照，检验每一次改进'}
        description={
          blind
            ? '评分完成前隐藏 Agent 数量、模型、策略和轨迹。样本顺序固定随机化。'
            : '冻结数据集与配置，保留失败样本、质量、耗时、成本和结论限制。'
        }
      />
      <Notice>离线实验不具备真实发布能力，实验成功不计为真实发布。</Notice>
      {blind ? (
        <section className="panel form-panel">
          <div className="panel-heading">
            <h2>匿名样本 01</h2>
            <span>待评分</span>
          </div>
          <p>任务要求：写一条关于日常灵感的微博。</p>
          <div className="blind-grid">
            <div className="inset">
              <h3>内容 A</h3>
              <p>给好奇心一点时间，让每一次尝试都有据可循。</p>
            </div>
            <div className="inset">
              <h3>内容 B</h3>
              <p>从日常的小问题开始，发现下一份灵感。</p>
            </div>
          </div>
          <label>
            更符合要求的内容
            <select value={score} onChange={(e) => setScore(e.target.value)}>
              <option value="">请选择</option>
              <option value="a">内容 A</option>
              <option value="b">内容 B</option>
            </select>
          </label>
          <label>
            评分理由
            <textarea rows={3} />
          </label>
          <PendingButton>提交盲评</PendingButton>
          <a className="text-link" href="/evaluations">
            返回实验摘要 →
          </a>
        </section>
      ) : (
        <section className="panel">
          <div className="panel-heading">
            <h2>单 Agent / 多 Agent 基线对照</h2>
            <span className="pill">示例 · 尚未运行</span>
          </div>
          <div className="metric-grid compact">
            {[
              ['固定样本', '20'],
              ['数据集', 'V1'],
              ['配置', 'V4'],
              ['真实发布', '0'],
            ].map(([label, value]) => (
              <div className="metric" key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
          <div className="detail-panel">
            <p className="muted">
              质量、耗时、成本和失败样本：运行完成后展示；结论允许“无明显优势”。
            </p>
            <div className="button-row">
              <PendingButton>运行已配置实验</PendingButton>
              <a className="button primary" href="/evaluations/experiment-demo/blind">
                预览人工盲评 →
              </a>
              <button disabled title="轨迹接入后提供真实链接">
                Langfuse 详情待接入 ↗
              </button>
            </div>
          </div>
        </section>
      )}
    </>
  );
}

export function Settings({ role }: { role: Role }) {
  const [tab, setTab] = useState('members');
  return (
    <>
      <PageTitle
        eyebrow="TEAM SETTINGS"
        title="清晰的权限，稳定的约定"
        description="成员、账号授权与基础规则由管理员维护。配置变更创建新版本，执行保留原配置快照。"
      />
      {role !== 'admin' ? (
        <>
          <Notice tone="warning">
            无管理权限。当前登录身份为运营人员；成员、账号授权及配置仅管理员可访问。
          </Notice>
          <Empty title="此页面仅管理员可用">如需管理成员或配置，请联系团队管理员。</Empty>
        </>
      ) : (
        <section className="panel">
          <div className="tab-row panel-tabs">
            {[
              ['members', '团队成员'],
              ['account', '账号授权'],
              ['rules', '基础规则与版本'],
            ].map(([value, label]) => (
              <button
                className={tab === value ? 'selected' : ''}
                key={value}
                onClick={() => setTab(value!)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="detail-panel">
            {tab === 'members' ? (
              <>
                <h2>团队成员</h2>
                <p>管理员 · 成员与配置管理</p>
                <p>运营人员 · 业务操作与评测</p>
                <PendingButton>修改成员权限</PendingButton>
                <p className="muted">最后一名有效管理员不可禁用或降级。</p>
              </>
            ) : tab === 'account' ? (
              <>
                <h2>品牌官方微博</h2>
                <Notice tone="warning">官方发布授权未配置；不能发起官方 API 发布。</Notice>
                <PendingButton>前往官方授权</PendingButton>
                <p className="muted">仅展示授权状态与验证结果，凭据不在页面明文展示。</p>
              </>
            ) : (
              <>
                <div className="panel-heading">
                  <h2>基础配置</h2>
                  <span className="pill">当前版本 V4</span>
                </div>
                <label>
                  账号简介
                  <textarea defaultValue="探索日常灵感，分享有依据的观点。" />
                </label>
                <label>
                  语气偏好
                  <input defaultValue="自然、克制、有温度" />
                </label>
                <label>
                  禁止事项
                  <textarea defaultValue="不得做无依据的效果承诺。" />
                </label>
                <label>
                  变更原因
                  <input placeholder="说明本次规则调整依据" />
                </label>
                <PendingButton>保存新配置版本</PendingButton>
                <Notice>配置冲突拒绝覆盖；规则变更导致资格不再满足时，需要重新审核和批准。</Notice>
              </>
            )}
          </div>
        </section>
      )}
    </>
  );
}
