import { useEffect, useRef, useState } from 'react';
import type { ConfigVersion } from '@multi-agent-ops/shared';
import { useAuth } from '../auth.js';
import { Notice } from '../components.js';
import { editorialRequest } from '../editorial-api.js';
import { TaskRequestError } from '../task-api.js';

const rules = [
  {
    id: 'plain-text-280',
    description: '纯文案，不超过 280 个字符，不含 HTML 标签。',
    deterministic: true,
  },
];
type Fields = { profile: string; tone: string; forbidden: string; reason: string; version: number };
const defaults: Fields = {
  profile: '团队文案账号，用于人工创作、审核和批准。',
  tone: '自然、克制、清晰',
  forbidden: '全网最低\n100%有效',
  reason: '',
  version: 1,
};
export function ConfigSettings() {
  const auth = useAuth(),
    key = `ops-config:${auth.session?.member.teamId}:${auth.session?.member.id}`;
  const [fields, setFields] = useState<Fields>(() => {
    try {
      const d = JSON.parse(sessionStorage.getItem(key) ?? 'null') as Fields;
      if (
        d &&
        typeof d.profile === 'string' &&
        typeof d.tone === 'string' &&
        typeof d.forbidden === 'string' &&
        typeof d.reason === 'string' &&
        Number.isSafeInteger(d.version)
      )
        return d;
    } catch {
      /* Defaults remain editable. */
    }
    return defaults;
  });
  const [config, setConfig] = useState<ConfigVersion | null>(null),
    [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [conflict, setConflict] = useState(false);
  const action = useRef<{ key: string; body: Record<string, unknown> } | null>(null);
  function change(value: Fields) {
    setFields(value);
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* Input remains in memory. */
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    void editorialRequest('/api/v1/config', 'Config', { signal: controller.signal })
      .then((r) => {
        if (controller.signal.aborted) return;
        setConfig(r.data);
        if (!sessionStorage.getItem(key))
          setFields({
            profile: r.data.profile,
            tone: r.data.tone,
            forbidden: r.data.forbiddenTopics.join('\n'),
            reason: '',
            version: r.data.version,
          });
        setLoaded(true);
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setLoaded(true);
        if (!(e instanceof TaskRequestError && e.status === 404))
          setError(e instanceof Error ? e.message : '配置读取失败。');
      });
    return () => controller.abort();
  }, [key]);
  async function save() {
    if (busy || !auth.session) return;
    if (!fields.profile.trim() || !fields.tone.trim() || !fields.reason.trim()) {
      setError('请填写账号简介、语气偏好和变更原因。');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    action.current ??= {
      key: crypto.randomUUID(),
      body: {
        expectedVersion: fields.version,
        profile: fields.profile,
        tone: fields.tone,
        forbiddenTopics: fields.forbidden
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean),
        rules,
        modelRef: config?.modelRef ?? 'manual',
        promptVersion: config?.promptVersion ?? 'manual-v1',
        toolVersion: 'basic-rules-v1',
        reason: fields.reason,
      },
    };
    try {
      const r = await editorialRequest('/api/v1/config', 'Config', {
        method: 'PUT',
        body: action.current.body,
        key: action.current.key,
        csrf: auth.session.csrfToken,
      });
      setConfig(r.data);
      setFields({ ...fields, version: r.data.version, reason: '' });
      sessionStorage.removeItem(key);
      action.current = null;
      setConflict(false);
      setNotice('配置已保存。已有文案需按新配置重新审核；旧批准已失效。');
    } catch (e) {
      setError(e instanceof Error ? e.message : '配置保存失败。');
      if (e instanceof TaskRequestError && !e.uncertain) action.current = null;
      if (e instanceof TaskRequestError && e.status === 409) {
        setConflict(true);
        try {
          const latest = await editorialRequest('/api/v1/config', 'Config');
          setConfig(latest.data);
        } catch {
          /* Keep original input if reloading also fails. */
        }
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <div className="panel-heading">
        <h2>基础配置</h2>
        <span className="pill">{config ? `当前配置 V${config.version}` : '尚未初始化'}</span>
      </div>
      <p className="muted">
        简介和语气作为人工审核参考；禁止事项每行填写一个明确词语，基础检查会直接匹配。首次保存文案会初始化默认配置。
      </p>
      {error && <Notice tone="danger">{error}</Notice>}
      {notice && <Notice tone="success">{notice}</Notice>}
      <label>
        账号简介
        <textarea
          aria-label="账号简介"
          maxLength={4000}
          value={fields.profile}
          disabled={busy || !!action.current}
          onChange={(e) => change({ ...fields, profile: e.target.value })}
        />
      </label>
      <label>
        语气偏好
        <input
          aria-label="语气偏好"
          maxLength={1000}
          value={fields.tone}
          disabled={busy || !!action.current}
          onChange={(e) => change({ ...fields, tone: e.target.value })}
        />
      </label>
      <label>
        禁止事项
        <textarea
          aria-label="禁止事项"
          maxLength={50000}
          rows={4}
          value={fields.forbidden}
          disabled={busy || !!action.current}
          onChange={(e) => change({ ...fields, forbidden: e.target.value })}
        />
      </label>
      <label>
        变更原因
        <input
          aria-label="变更原因"
          maxLength={2000}
          value={fields.reason}
          disabled={busy || !!action.current}
          onChange={(e) => change({ ...fields, reason: e.target.value })}
        />
      </label>
      {conflict && config && (
        <div className="inset">
          <strong>服务器配置 V{config.version}，你的输入已保留。</strong>
          <p>简介：{config.profile}</p>
          <p>语气：{config.tone}</p>
          <p>禁止事项：{config.forbiddenTopics.join('、') || '无'}</p>
          <button
            disabled={busy}
            onClick={() => {
              change({ ...fields, version: config.version });
              setConflict(false);
              setError('');
            }}
          >
            保留输入并以最新配置为基础
          </button>
        </div>
      )}
      <button
        className="primary"
        disabled={!loaded || busy || conflict}
        onClick={() => void save()}
      >
        {busy ? '正在保存配置…' : action.current ? '重试确认配置保存' : '保存新配置版本'}
      </button>
      <p className="muted">内置规则：纯文案，最多 280 个字符。确定性阻断不能通过人工裁决放行。</p>
    </div>
  );
}
