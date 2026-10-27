import { useEffect, useState } from 'react';
import { PROJECT_NAME } from '@multi-agent-ops/shared';
import type { DatabaseReadiness } from '@multi-agent-ops/shared';

type State = 'loading' | 'ok' | 'offline' | 'unconfigured';
const labels: Record<State, string> = {
  loading: '检测中',
  ok: '已连接',
  offline: '未连接',
  unconfigured: '待配置',
};
export function Overview() {
  const [backend, setBackend] = useState<State>('loading');
  const [agent, setAgent] = useState<State>('loading');
  const [database, setDatabase] = useState<State>('loading');
  useEffect(() => {
    const controller = new AbortController();
    async function check() {
      const fetcher = (url: string) => fetch(url, { signal: controller.signal });
      await Promise.all([
        fetcher('/api/health')
          .then((response) => setBackend(response.ok ? 'ok' : 'offline'))
          .catch(() => {
            if (!controller.signal.aborted) setBackend('offline');
          }),
        fetcher('/api/agent-health')
          .then((response) => setAgent(response.ok ? 'ok' : 'offline'))
          .catch(() => {
            if (!controller.signal.aborted) setAgent('offline');
          }),
        fetcher('/api/ready')
          .then(async (response) => {
            const data = (await response.json()) as DatabaseReadiness;
            setDatabase(
              data.database === 'connected'
                ? 'ok'
                : data.database === 'unconfigured'
                  ? 'unconfigured'
                  : 'offline',
            );
          })
          .catch(() => {
            if (!controller.signal.aborted) setDatabase('offline');
          }),
      ]);
    }
    void check();
    const timer = setInterval(() => {
      void check();
    }, 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, []);
  const services = [
    { name: '后端服务', detail: 'Fastify · TypeScript', state: backend },
    { name: 'Agent 空壳', detail: '独立入口 · 尚无执行能力', state: agent },
    { name: '业务数据库', detail: 'PostgreSQL 16 · 本地持久卷', state: database },
  ];
  return (
    <>
      <section className="intro">
        <p className="eyebrow">BUILD THE FOUNDATION</p>
        <h1>{PROJECT_NAME}</h1>
        <p className="description">让研究、创作与审核在同一个工作流中协作。</p>
        <div className="scope">
          <span>微博 · 单账号</span>
          <span>纯文案</span>
          <span>人工批准发布</span>
        </div>
      </section>
      <section aria-labelledby="services-title">
        <div className="section-heading">
          <h2 id="services-title">运行环境</h2>
          <span>每 5 秒更新连接状态</span>
        </div>
        <div className="cards">
          {services.map((service, index) => (
            <article className="card" key={service.name}>
              <div className="card-top">
                <span className="service-index">0{index + 1}</span>
                <span className={`badge ${service.state}`}>
                  <span />
                  {labels[service.state]}
                </span>
              </div>
              <h3>{service.name}</h3>
              <p>{service.detail}</p>
            </article>
          ))}
        </div>
      </section>
      <section className="foundation">
        <div className="foundation-icon">↗</div>
        <div>
          <h2>基础已就位，业务即将开始</h2>
          <p>
            当前仅提供工程骨架与连接检测。任务创建、模型调用、记忆和发布能力将在后续开发中逐步接入。
          </p>
          {database !== 'ok' && (
            <p className="hint">数据库未就绪时，前后端仍可启动；请按 README 完成本地数据库配置。</p>
          )}
        </div>
        <span className="tag">开发预览</span>
      </section>
      <footer>
        frontend / backend / agent <span>统一契约 · 独立职责 · 可追溯协作</span>
      </footer>
    </>
  );
}
