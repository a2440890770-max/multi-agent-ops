import { useEffect, useRef, useState } from 'react';
import type { AccountRegistration as Registration, OperationBodies } from '@multi-agent-ops/shared';
import { useAuth } from '../auth.js';
import { Notice } from '../components.js';
import { readAccountRegistration, saveAccountRegistration, weiboUid } from '../account-api.js';
import { TaskRequestError } from '../task-api.js';

type Fields = {
  displayName: string;
  target: string;
  enabled: boolean;
  confirmed: boolean;
  reason: string;
  version: number;
};
type Pending = { key: string; body: OperationBodies['registerAccount'] };
const empty: Fields = {
  displayName: '',
  target: '',
  enabled: false,
  confirmed: false,
  reason: '',
  version: 0,
};
const fieldsFor = (r: Registration): Fields =>
  r.account
    ? {
        ...empty,
        displayName: r.account.registrationVersion ? r.account.displayName : '',
        target: r.account.platformAccountId ?? '',
        enabled: r.account.manualPublishEnabled,
        version: r.account.registrationVersion,
      }
    : empty;
function pendingFrom(key: string): Pending | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? 'null') as Pending;
    if (
      value &&
      /^[a-f0-9-]{36}$/.test(value.key) &&
      Number.isSafeInteger(value.body?.expectedVersion) &&
      typeof value.body.displayName === 'string' &&
      /^[1-9][0-9]{0,19}$/.test(value.body.platformAccountId) &&
      typeof value.body.manualPublishEnabled === 'boolean' &&
      typeof value.body.manualAuthorizationConfirmed === 'boolean' &&
      typeof value.body.reason === 'string'
    )
      return value;
  } catch {
    /* No credentials are stored. */
  }
  return null;
}
export function AccountRegistration() {
  const auth = useAuth();
  const storageKey = `ops-account-registration:${auth.session?.member.teamId}:${auth.session?.member.id}`;
  const [pending, setPending] = useState<Pending | null>(() => pendingFrom(storageKey));
  const [fields, setFields] = useState<Fields>(empty);
  const [current, setCurrent] = useState<Registration | null>(null);
  const [latest, setLatest] = useState<Registration | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoaded(false);
    void readAccountRegistration(controller.signal)
      .then(({ data }) => {
        if (controller.signal.aborted) return;
        setCurrent(data);
        const original = pendingFrom(storageKey);
        setFields(
          original
            ? {
                displayName: original.body.displayName,
                target: original.body.platformAccountId,
                enabled: original.body.manualPublishEnabled,
                confirmed: original.body.manualAuthorizationConfirmed,
                reason: original.body.reason,
                version: original.body.expectedVersion,
              }
            : fieldsFor(data),
        );
        setLoaded(true);
        setError('');
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : '账号登记读取失败。');
        if (e instanceof TaskRequestError && e.status === 401) void auth.refresh();
      });
    return () => controller.abort();
  }, [storageKey, reload, auth.refresh]);
  async function save() {
    if (working.current || !auth.session || !loaded || latest) return;
    const uid = weiboUid(fields.target);
    if (
      !pending &&
      (!fields.displayName.trim() ||
        !uid ||
        !fields.reason.trim() ||
        (fields.enabled && !fields.confirmed))
    ) {
      setError('请填写昵称、有效的微博主页链接或UID、登记原因；启用人工操作时须确认操作资格。');
      return;
    }
    const action = pending ?? {
      key: crypto.randomUUID(),
      body: {
        expectedVersion: fields.version,
        displayName: fields.displayName.trim(),
        platformAccountId: uid!,
        manualPublishEnabled: fields.enabled,
        manualAuthorizationConfirmed: fields.confirmed,
        reason: fields.reason.trim(),
      },
    };
    working.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    setPending(action);
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(action));
    } catch {
      /* The in-memory key still prevents a duplicate action. */
    }
    try {
      const { data } = await saveAccountRegistration(
        action.body,
        auth.session.csrfToken,
        action.key,
      );
      setPending(null);
      try {
        sessionStorage.removeItem(storageKey);
      } catch {
        /* No credentials are stored. */
      }
      const fresh = await readAccountRegistration();
      setCurrent(fresh.data);
      setFields(fieldsFor(fresh.data));
      setNotice(
        `目标账号登记已保存（V${data.account?.registrationVersion}）。首次登记、更换UID或停用人工操作资格会使旧批准失效。`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : '登记结果尚未确认，请重试原请求。');
      if (e instanceof TaskRequestError && !e.uncertain) {
        setPending(null);
        try {
          sessionStorage.removeItem(storageKey);
        } catch {
          /* Keep input in memory. */
        }
        if (e.code === 'REVISION_CONFLICT') {
          try {
            setLatest((await readAccountRegistration()).data);
          } catch {
            /* Keep the original version until a successful read. */
          }
        }
      }
      if (e instanceof TaskRequestError && e.status === 401) void auth.refresh();
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  const locked = busy || !!pending;
  return (
    <div>
      <h2>目标微博账号登记</h2>
      <p className="muted">
        登记团队唯一的真实微博账号。人工操作资格由管理员确认，与官方API授权分开保存。
      </p>
      {error && <Notice tone="danger">{error}</Notice>}
      {notice && <Notice tone="success">{notice}</Notice>}
      {!loaded && <button onClick={() => setReload((n) => n + 1)}>重新读取账号登记</button>}
      {current?.account?.registrationVersion ? (
        <div className="inset">
          <strong>已登记：{current.account.displayName}</strong>
          <p>
            UID：{current.account.platformAccountId} · 登记 V{current.account.registrationVersion}
          </p>
          <p>人工操作资格：{current.account.manualPublishEnabled ? '已启用' : '未启用'}</p>
          <p>
            登记人：{current.registeredBy} ·{' '}
            {current.registeredAt && new Date(current.registeredAt).toLocaleString('zh-CN')}
          </p>
        </div>
      ) : (
        <p>尚未登记真实目标账号。</p>
      )}
      {pending && (
        <Notice tone="warning">
          上次登记请求尚未确认。请使用原请求重试确认，避免覆盖其他人的更新。
        </Notice>
      )}
      <label>
        微博昵称
        <input
          aria-label="微博昵称"
          maxLength={100}
          value={fields.displayName}
          disabled={!loaded || locked}
          onChange={(e) => setFields({ ...fields, displayName: e.target.value })}
        />
      </label>
      <label>
        微博主页链接或 UID
        <input
          aria-label="微博主页链接或 UID"
          maxLength={2048}
          placeholder="https://weibo.com/u/数字 或数字UID"
          value={fields.target}
          disabled={!loaded || locked}
          onChange={(e) => setFields({ ...fields, target: e.target.value })}
        />
      </label>
      {weiboUid(fields.target) && (
        <p className="muted">
          目标主页：
          <a
            href={`https://weibo.com/u/${weiboUid(fields.target)}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            https://weibo.com/u/{weiboUid(fields.target)}
          </a>
        </p>
      )}
      <label className="account-check">
        <input
          type="checkbox"
          checked={fields.enabled}
          disabled={!loaded || locked}
          onChange={(e) => setFields({ ...fields, enabled: e.target.checked, confirmed: false })}
        />
        启用人工操作资格
      </label>
      {fields.enabled && (
        <label className="account-check">
          <input
            type="checkbox"
            checked={fields.confirmed}
            disabled={!loaded || locked}
            onChange={(e) => setFields({ ...fields, confirmed: e.target.checked })}
          />
          我确认团队指定人员有权登录该账号并手动发布
        </label>
      )}
      <label>
        登记或变更原因
        <input
          aria-label="登记或变更原因"
          maxLength={2000}
          value={fields.reason}
          disabled={!loaded || locked}
          onChange={(e) => setFields({ ...fields, reason: e.target.value })}
        />
      </label>
      {latest && (
        <div className="inset">
          <strong>服务器登记已更新，你的输入已保留。</strong>
          <p>
            当前：{latest.account?.displayName ?? '未登记'} · UID{' '}
            {latest.account?.platformAccountId ?? '无'} · V
            {latest.account?.registrationVersion ?? 0}
          </p>
          <button
            disabled={busy}
            onClick={() => {
              setCurrent(latest);
              setFields({
                ...fields,
                version: latest.account?.registrationVersion ?? 0,
                confirmed: false,
              });
              setLatest(null);
              setError('');
            }}
          >
            保留输入并以最新登记为基础
          </button>
        </div>
      )}
      <button
        className="primary"
        disabled={!loaded || busy || !!latest}
        onClick={() => void save()}
      >
        {busy ? '正在保存账号…' : pending ? '重试确认账号登记' : '保存目标账号登记'}
      </button>
      <p className="muted">本页不申请或变更官方API授权，也不需要账号密码、验证码或Cookie。</p>
    </div>
  );
}
