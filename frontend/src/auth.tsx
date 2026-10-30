import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Session } from '@multi-agent-ops/shared';
import { authRequest, AuthRequestError, validSession } from './auth-api.js';

type AuthState = {
  status: 'loading' | 'anonymous' | 'authenticated' | 'unavailable';
  session: Session | null;
  message: string;
};
type AuthContextValue = AuthState & {
  refresh: () => Promise<Session | null>;
  login: (login: string, password: string, key: string) => Promise<void>;
  logout: () => Promise<boolean>;
  signingOut: boolean;
};
const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading', session: null, message: '' });
  const [signingOut, setSigningOut] = useState(false);
  const stateRef = useRef(state);
  const generation = useRef(0);
  const signingOutRef = useRef(false);
  const mutating = useRef(false);
  const channel = useRef<BroadcastChannel | null>(null);
  stateRef.current = state;

  const refresh = useCallback(async () => {
    if (mutating.current) return null;
    const current = ++generation.current;
    try {
      const session = await authRequest<Session>('me');
      if (!validSession(session)) throw new AuthRequestError(401, '登录已过期，请重新登录。');
      if (current === generation.current)
        setState({ status: 'authenticated', session, message: '' });
      return session;
    } catch (error) {
      if (current !== generation.current) return null;
      if (error instanceof AuthRequestError && error.status === 401) {
        setState((previous) => ({
          status: 'anonymous',
          session: null,
          message: previous.session
            ? '登录已过期或账号状态已变化，请重新登录。'
            : previous.status === 'anonymous'
              ? previous.message
              : '',
        }));
      } else {
        setState((previous) => ({
          status: previous.session ? 'authenticated' : 'unavailable',
          session: previous.session,
          message: error instanceof Error ? error.message : '无法确认登录状态，请重试。',
        }));
      }
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh();
    let lastCheck = 0;
    const check = () => {
      if (document.visibilityState !== 'visible' || signingOutRef.current) return;
      const now = Date.now();
      if (now - lastCheck < 5000) return;
      lastCheck = now;
      void refresh();
    };
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    const interval = window.setInterval(() => {
      if (stateRef.current.status === 'authenticated') check();
    }, 30000);
    if (typeof BroadcastChannel !== 'undefined') {
      channel.current = new BroadcastChannel('ops-auth');
      channel.current.onmessage = () => {
        void refresh();
      };
    }
    return () => {
      ++generation.current;
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
      window.clearInterval(interval);
      channel.current?.close();
      channel.current = null;
    };
  }, [refresh]);

  useEffect(() => {
    if (!state.session) return;
    const expiresAt = Date.parse(state.session.expiresAt);
    const timer = window.setTimeout(
      () => {
        ++generation.current;
        setState({ status: 'anonymous', session: null, message: '登录已过期，请重新登录。' });
      },
      Math.max(0, expiresAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [state.session]);

  const login = useCallback(async (login: string, password: string, key: string) => {
    mutating.current = true;
    const current = ++generation.current;
    try {
      await authRequest<Session>('login', { body: { login, password }, key });
      // Confirm current permissions instead of treating the login POST alone as UI success.
      const session = await authRequest<Session>('me');
      if (!validSession(session)) throw new AuthRequestError(401, '登录已失效，请重新登录。');
      if (current === generation.current) {
        setState({ status: 'authenticated', session, message: '' });
        channel.current?.postMessage({ type: 'changed' });
      }
    } catch (error) {
      if (
        current === generation.current &&
        error instanceof AuthRequestError &&
        (error.status === 0 || error.status >= 500)
      )
        setState({ status: 'unavailable', session: null, message: error.message });
      throw error;
    } finally {
      mutating.current = false;
    }
  }, []);

  const logout = useCallback(async () => {
    if (signingOutRef.current) return false;
    signingOutRef.current = true;
    mutating.current = true;
    setSigningOut(true);
    const current = ++generation.current;
    try {
      await authRequest<{ signedOut: true }>('logout', {
        ...(stateRef.current.session ? { csrf: stateRef.current.session.csrfToken } : {}),
      });
      if (current === generation.current) {
        setState({ status: 'anonymous', session: null, message: '已退出登录。' });
        channel.current?.postMessage({ type: 'changed' });
      }
      return true;
    } catch (error) {
      if (current === generation.current)
        setState((previous) => ({
          ...previous,
          message: error instanceof Error ? error.message : '退出尚未确认，请重试。',
        }));
      return false;
    } finally {
      signingOutRef.current = false;
      mutating.current = false;
      setSigningOut(false);
    }
  }, []);

  return (
    <AuthContext.Provider value={{ ...state, refresh, login, logout, signingOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('AuthProvider is required');
  return value;
}
