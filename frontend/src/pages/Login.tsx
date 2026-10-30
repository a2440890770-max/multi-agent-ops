import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth.js';
import { Notice, PageTitle } from '../components.js';
import { loginDestination, navigate } from '../navigation.js';

export function Login({ search }: { search: string }) {
  const auth = useAuth();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [checking, setChecking] = useState(false);
  const busy = useRef(false);
  useEffect(() => {
    if (auth.status === 'authenticated') navigate(loginDestination(search), true);
  }, [auth.status, search]);
  const disabled = submitting || auth.status !== 'anonymous';
  return (
    <>
      <PageTitle
        eyebrow="TEAM ACCESS"
        title="成员登录"
        description="使用团队内部账号登录，身份和权限由服务端确认。"
      />
      <form
        className="panel form-panel narrow"
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy.current || disabled) return;
          busy.current = true;
          setSubmitting(true);
          setMessage('');
          try {
            await auth.login(login.trim(), password, crypto.randomUUID());
          } catch (error) {
            setMessage(error instanceof Error ? error.message : '登录未完成，请重试。');
          } finally {
            setPassword('');
            setSubmitting(false);
            busy.current = false;
          }
        }}
      >
        <h2>登录团队</h2>
        {auth.status === 'loading' && <Notice>正在检查登录状态…</Notice>}
        {(message || auth.message) && (
          <Notice tone={auth.status === 'unavailable' ? 'warning' : message ? 'danger' : 'info'}>
            {message || auth.message}
          </Notice>
        )}
        <label>
          登录账号
          <input
            name="login"
            autoComplete="username"
            required
            maxLength={254}
            value={login}
            onChange={(event) => setLogin(event.target.value)}
            placeholder="团队成员账号"
            disabled={submitting}
          />
        </label>
        <label>
          密码
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            minLength={8}
            maxLength={256}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="请输入密码"
            disabled={submitting}
          />
        </label>
        <button className="primary" type="submit" disabled={disabled}>
          {submitting ? '正在登录…' : '登录'}
        </button>
        {auth.status === 'unavailable' && (
          <button
            type="button"
            disabled={checking}
            onClick={async () => {
              setChecking(true);
              setMessage('');
              try {
                await auth.refresh();
              } finally {
                setChecking(false);
              }
            }}
          >
            {checking ? '正在检查…' : '重新检查登录状态'}
          </button>
        )}
        <p className="muted">账号由管理员创建。登录有效期为 8 小时，退出后会话立即失效。</p>
        <a className="text-link" href="/">
          查看服务状态 →
        </a>
      </form>
    </>
  );
}
