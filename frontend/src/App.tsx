import { useEffect, useState } from 'react';
import { Overview } from './pages/Overview.js';
import { Memories, Evaluations, Settings } from './pages/Workspace.js';
import { Tasks } from './pages/Tasks.js';
import { CreateTask } from './pages/CreateTask.js';
import { Login } from './pages/Login.js';
import { TaskDetailPage } from './pages/TaskDetail.js';
import { PreviewTaskDetailPage } from './pages/PreviewTaskDetail.js';
import { Empty, Notice } from './components.js';
import { useAuth } from './auth.js';
import { navigate as navigateTo } from './navigation.js';

const navigation = [
  { path: '/', icon: '◈', label: '项目概览' },
  { path: '/tasks', icon: '▤', label: '任务工作台' },
  { path: '/memories', icon: '◇', label: '记忆管理' },
  { path: '/evaluations', icon: '◫', label: '评测中心' },
  { path: '/settings', icon: '⚙', label: '管理设置' },
];
export function App() {
  const [location, setLocation] = useState(window.location.pathname + window.location.search);
  const auth = useAuth();
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
  const protectedPage = ['/tasks', '/previews', '/memories', '/evaluations', '/settings'].some(
    (prefix) => path === prefix || path.startsWith(prefix + '/'),
  );
  useEffect(() => {
    if (protectedPage && auth.status === 'anonymous')
      navigateTo('/login?next=' + encodeURIComponent(location), true);
  }, [protectedPage, auth.status, location]);
  useEffect(() => {
    document.title = `${navigation.find((n) => n.path !== '/' && path.startsWith(n.path))?.label ?? (path === '/login' ? '成员登录' : '项目概览')} · Agent Ops`;
  }, [path]);
  const taskMatch = /^\/tasks\/([A-Za-z0-9_-]+)$/.exec(path);
  const previewMatch = /^\/previews\/tasks\/([A-Za-z0-9_-]+)$/.exec(path);
  const liveTaskPage = path === '/tasks' || !!taskMatch;
  const currentNav = navigation.find((item) =>
    item.path === '/'
      ? path === '/'
      : path.startsWith(item.path) || (item.path === '/tasks' && !!previewMatch),
  );
  let page;
  if (path === '/') page = <Overview />;
  else if (path === '/login') page = <Login search={location.split('?')[1] ?? ''} />;
  else if (path === '/tasks')
    page = <Tasks key={`${auth.session?.member.teamId}:${auth.session?.member.id}`} />;
  else if (path === '/tasks/new')
    page = <CreateTask key={`${auth.session?.member.teamId}:${auth.session?.member.id}`} />;
  else if (taskMatch)
    page = (
      <TaskDetailPage
        key={`${auth.session?.member.teamId}:${auth.session?.member.id}:${taskMatch[1]}`}
        taskId={taskMatch[1]!}
      />
    );
  else if (previewMatch)
    page = (
      <PreviewTaskDetailPage
        key={previewMatch[1]}
        taskId={previewMatch[1]!}
        search={location.split('?')[1] ?? ''}
      />
    );
  else if (path === '/memories') page = <Memories />;
  else if (path === '/evaluations' || /^\/evaluations\/[^/]+\/blind$/.test(path))
    page = <Evaluations blind={path.endsWith('/blind')} />;
  else if (path === '/settings') page = <Settings role={auth.session?.member.role ?? 'operator'} />;
  else
    page = (
      <Empty title="页面不存在">
        <a href="/tasks">返回任务工作台 →</a>
      </Empty>
    );
  if (protectedPage && auth.status !== 'authenticated')
    page = (
      <section className="panel form-panel narrow">
        <Notice>{auth.status === 'unavailable' ? auth.message : '正在确认登录身份…'}</Notice>
        {auth.status === 'unavailable' && (
          <button
            onClick={() => {
              void auth.refresh();
            }}
          >
            重新检查登录状态
          </button>
        )}
        <a className="text-link" href="/login">
          前往登录 →
        </a>
      </section>
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
            <strong>微博运营账号</strong>
            <small>在任务详情查看绑定状态</small>
          </div>
        </div>
        <div className="sidebar-footer">
          {auth.session ? (
            <>
              <strong>{auth.session.member.displayName}</strong>
              <span>{auth.session.member.role === 'admin' ? '管理员' : '运营人员'}</span>
              <button
                disabled={auth.signingOut}
                onClick={async () => {
                  if (await auth.logout()) navigateTo('/login', true);
                }}
              >
                {auth.signingOut ? '正在退出…' : '退出登录'}
              </button>
            </>
          ) : (
            <>
              <span>{auth.status === 'loading' ? '正在确认身份…' : '未登录'}</span>
              <a href="/login">成员登录 ↗</a>
            </>
          )}
        </div>
      </aside>
      <main>
        <header>
          <span>
            工作区 / <strong>{currentNav?.label ?? '成员入口'}</strong>
          </span>
          <span className="stage">
            D4 ·{' '}
            {path === '/login'
              ? '成员登录'
              : path === '/'
                ? '工程与连接'
                : liveTaskPage
                  ? path === '/tasks'
                    ? '任务列表'
                    : path === '/tasks/new'
                      ? '创建任务'
                      : '任务详情'
                  : '业务页面预览'}
          </span>
        </header>
        {path !== '/' && path !== '/login' && !liveTaskPage && auth.status === 'authenticated' && (
          <div className="preview-banner">
            <span>业务预览</span>登录身份已验证；业务内容使用示例数据，操作不会保存或实际发布。
          </div>
        )}
        {path !== '/login' && auth.message && <Notice tone="warning">{auth.message}</Notice>}
        {page}
      </main>
    </div>
  );
}
