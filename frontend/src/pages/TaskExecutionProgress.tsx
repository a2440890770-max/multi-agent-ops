import { useEffect, useState } from 'react';
import type { ExecutionAttempt, Failure, TaskDetail } from '@multi-agent-ops/shared';
import { Notice } from '../components.js';
import {
  durationLabel,
  executionDuration,
  failureGuidance,
  initialQueueDuration,
} from '../execution-display.js';

export function useExecutionClock(active: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

export function AttemptTimes({ attempt, now }: { attempt: ExecutionAttempt; now: number }) {
  return (
    <dl className="task-metadata" data-testid="attempt-times">
      <dt>首次排队耗时</dt>
      <dd>{durationLabel(initialQueueDuration(attempt, now))}</dd>
      <dt>累计执行耗时</dt>
      <dd>{durationLabel(executionDuration(attempt, now))}</dd>
    </dl>
  );
}

export function ExecutionFailure({
  failure,
  guidance = true,
}: {
  failure: Failure;
  guidance?: boolean;
}) {
  const help = failureGuidance(failure);
  return (
    <Notice tone="danger">
      <strong>{help.title}：</strong>
      {failure.message}
      <span className="execution-error-code">原因编号：{failure.code}</span>
      {guidance && <p>{help.next}</p>}
    </Notice>
  );
}

export function TaskExecutionProgress({ detail }: { detail: TaskDetail }) {
  const attempt = detail.currentAttempt;
  const now = useExecutionClock(['queued', 'running'].includes(detail.execution ?? ''));
  const operation = detail.currentPublication;
  const dispatch = operation?.dispatches.find((item) => item.id === operation.currentDispatchId);
  return (
    <section className="panel detail-panel" aria-labelledby="progress-title">
      <h2 id="progress-title">执行进度</h2>
      <p>
        <strong>当前步骤：</strong>
        {detail.currentStep ?? '尚未开始'}
      </p>
      {detail.execution === 'queued' && (
        <Notice>排队中，等待执行器领取；排队不计入累计执行耗时。</Notice>
      )}
      {detail.execution === 'awaiting_clarification' && (
        <Notice tone="warning">
          需人工处理：请在“澄清问答”区补充答复；等待澄清不计入累计执行耗时。
        </Notice>
      )}
      {attempt && <AttemptTimes attempt={attempt} now={now} />}
      {attempt && <p className="muted">累计执行耗时包含调用和技术重试等待，排除排队与等待澄清。</p>}
      {attempt?.error ? (
        <ExecutionFailure failure={attempt.error} />
      ) : detail.errorMessage ? (
        <Notice tone="danger">{detail.errorMessage}</Notice>
      ) : null}
      {detail.execution === 'manual_required' && (
        <Notice tone="warning">
          需人工处理：{detail.currentStep ?? '执行流程需要人工接手，请核对任务记录后处理。'}
        </Notice>
      )}
      {detail.publication === 'verification_required' && (
        <Notice tone="warning">
          <strong>需人工处理：发布结果待核实。</strong>
          <p>
            {dispatch?.error?.message ?? '当前无法确认是否已发布。'}{' '}
            请先核对平台实际发布结果并在发布记录中追加核实；确认前不能取消或重新发布。
          </p>
          {dispatch?.error && (
            <span className="execution-error-code">原因编号：{dispatch.error.code}</span>
          )}
          <a className="text-link" href="#frozen-handoff-title">
            查看发布记录与核实入口
          </a>
        </Notice>
      )}
      {detail.publication === 'failed' && dispatch?.error && (
        <Notice tone="danger">
          发布失败：{dispatch.error.message} 请在发布记录中核对原因和未发布证据后处理。
        </Notice>
      )}
      {attempt?.executorMode === 'mock' && (
        <p className="muted">当前为模拟执行，进度和步骤已保存至数据库。</p>
      )}
    </section>
  );
}
