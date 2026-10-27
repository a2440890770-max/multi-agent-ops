import { useEffect, useState } from 'react';
import type { Role } from '@multi-agent-ops/shared';
import { Overview } from './pages/Overview.js';
import { Tasks, CreateTask, Login, Memories, Evaluations, Settings } from './pages/Workspace.js';
import { TaskDetailPage } from './pages/TaskDetail.js';
import { Empty } from './components.js';

const navigation = [
  { path: '/', icon: '◈', label: '项目概览' },
  { path: '/tasks', icon: '▤', label: '任务工作台' },
  { path: '/memories', icon: '◇', label: '记忆管理' },
  { path: '/evaluations', icon: '◫', label: '评测中心' },
  { path: '/settings', icon: '⚙', label: '管理设置' },
];
export function App() {
  const [location, setLocation] = useState(window.location.pathname + window.location.search);
  const [role, setRole] = useState<Role>('operator');
  useEffect(() => {
    const update = () => setLocation(window.location.pathname + window.location.search);
    const navigate = (event: MouseEvent) => {
      const anchor = (event.target as HTMLElement).closest('a');
      if (
        !anchor ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        anchor.target ||
        anchor.hasAttribute('download')
      )
        return;
      const url = new URL(anchor.href);
      if (url.origin !== window.location.origin || url.pathname.startsWith('/api/')) return;
      event.preventDefault();
      window.history.pushState({}, '', url.pathname + url.search + url.hash);
      update();
      if (url.hash)
        requestAnimationFrame(() => document.getElementById(url.hash.slice(1))?.scrollIntoView());
      else window.scrollTo(0, 0);
    };
    window.addEventListener('popstate', update);
    document.addEventListener('click', navigate);
    return () => {
      window.removeEventListener('popstate', update);
      document.removeEventListener('click', navigate);
    };
  }, []);
  const path = location.split('?')[0]!;
  useEffect(() => {
    document.title = `${navigation.find((n) => n.path !== '/' && path.startsWith(n.path))?.label ?? (path === '/login' ? '成员登录' : '项目概览')} · Agent Ops`;
  }, [path]);
  const taskMatch = /^\/tasks\/([A-Za-z0-9_-]+)$/.exec(path);
  const currentNav = navigation.find((item) =>
    item.path === '/' ? path === '/' : path.startsWith(item.path),
  );
  let page;
  if (path === '/') page = <Overview />;
  else if (path === '/login') page = <Login />;
  else if (path === '/tasks') page = <Tasks />;
  else if (path === '/tasks/new') page = <CreateTask />;
  else if (taskMatch)
    page = (
      <TaskDetailPage
        key={taskMatch[1]}
        taskId={taskMatch[1]!}
        search={location.split('?')[1] ?? ''}
      />
    );
  else if (path === '/memories') page = <Memories />;
  else if (path === '/evaluations' || /^\/evaluations\/[^/]+\/blind$/.test(path))
    page = <Evaluations blind={path.endsWith('/blind')} />;
  else if (path === '/settings') page = <Settings role={role} />;
  else
    page = (
      <Empty title="页面不存在">
        <a href="/tasks">返回任务工作台 →</a>
      </Empty>
    );
  return (
    <div className="layout">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Multi-Agent Ops 首页">
          <span className="brand-icon">M</span>
          <span>
            Agent Ops<small>运营协作工作区</small>
          </span>
        </a>
        <p className="nav-label">工作空间</p>
        <nav aria-label="主导航">
          {navigation.map((item) => (
            <a
              key={item.path}
              className={`nav-item ${currentNav?.path === item.path ? 'active' : ''}`}
              href={item.path}
              aria-current={currentNav?.path === item.path ? 'page' : undefined}
            >
              <span aria-hidden="true">{item.icon}</span>
              <span>{item.label}</span>
              {currentNav?.path === item.path && <span className="nav-dot" />}
            </a>
          ))}
        </nav>
        <div className="account-card">
          <span className="avatar">微</span>
          <div>
            <strong>品牌官方微博</strong>
            <small>单账号 · 纯文案</small>
          </div>
        </div>
        <div className="sidebar-footer">
          <label htmlFor="preview-role">预览身份（非登录）</label>
          <select id="preview-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="operator">运营人员</option>
            <option value="admin">管理员</option>
          </select>
          <a href="/login">成员登录 / 退出入口 ↗</a>
        </div>
      </aside>
      <main>
        <header>
          <span>
            工作区 / <strong>{currentNav?.label ?? '成员入口'}</strong>
          </span>
          <span className="stage">D1 · {path === '/' ? '工程与连接' : '页面设计预览'}</span>
        </header>
        {path !== '/' && (
          <div className="preview-banner">
            <span>设计预览</span>页面使用示例数据；业务接口尚未接入，操作不会保存或实际发布。
          </div>
        )}
        {page}
      </main>
    </div>
  );
}
