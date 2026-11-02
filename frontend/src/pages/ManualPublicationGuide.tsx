import { useRef, useState } from 'react';
import type { PublishOperation } from '@multi-agent-ops/shared';
import { Notice } from '../components.js';

export function ManualPublicationGuide({ operation }: { operation: PublishOperation }) {
  const { snapshot } = operation;
  const text = useRef<HTMLTextAreaElement>(null);
  const copying = useRef(false);
  const [phase, setPhase] = useState<'idle' | 'copying' | 'copied' | 'failed' | 'selected'>('idle');
  const dispatch = operation.dispatches.find((item) => item.id === operation.currentDispatchId);
  const awaitingManual = operation.status === 'awaiting_manual' && dispatch?.channel === 'manual';

  async function copy() {
    if (copying.current || !awaitingManual) return;
    copying.current = true;
    setPhase('copying');
    try {
      await navigator.clipboard.writeText(snapshot.content.body);
      setPhase('copied');
    } catch {
      setPhase('failed');
    } finally {
      copying.current = false;
    }
  }

  function select() {
    if (!text.current) return;
    text.current.focus();
    text.current.select();
    setPhase('selected');
  }

  return (
    <>
      <label>
        冻结文案
        <textarea
          ref={text}
          aria-label="冻结文案"
          readOnly
          rows={6}
          value={snapshot.content.body}
        />
      </label>
      {awaitingManual && (
        <>
          <div className="button-row">
            <button className="primary" disabled={phase === 'copying'} onClick={() => void copy()}>
              {phase === 'copying' ? '正在复制…' : '复制冻结文案'}
            </button>
            <button disabled={phase === 'copying'} onClick={select}>
              选中全文手动复制
            </button>
          </div>
          {phase === 'copied' && (
            <Notice tone="success">
              已复制冻结文案，保留原始空格和换行。请在微博粘贴后再次核对内容。
            </Notice>
          )}
          {phase === 'failed' && (
            <Notice tone="danger">
              自动复制失败。请点击“选中全文手动复制”，再按 ⌘C / Ctrl+C 或使用系统复制菜单。
            </Notice>
          )}
          {phase === 'selected' && (
            <Notice>已选中冻结文案，请按 ⌘C / Ctrl+C 或使用系统复制菜单。尚未确认复制成功。</Notice>
          )}
          <section aria-labelledby="manual-publication-guide-title" className="publication-guide">
            <h4 id="manual-publication-guide-title">人工发布指引</h4>
            <ol>
              <li>
                登录微博，核对当前账号为“{snapshot.account.displayName}”（UID：
                {snapshot.account.platformAccountId}），与上方交接账号主页一致后再继续。
              </li>
              <li>点击“复制冻结文案”，将正文粘贴到微博发布编辑器。复制内容仅包含冻结原文。</li>
              <li>
                对照冻结文案逐字核对，包括空格、换行和首尾内容。若需修改，请先停止原交接并回填“明确未发布”，解锁后保存新版本、重新审核批准。
              </li>
              <li>确认账号与内容无误后，由有权限的人员在微博手动发布。</li>
              <li>
                发布后打开该条微博，核对发布账号和实际内容并保存该条微博的链接，返回本页面回填结果。
                若内容与批准版不一致，请保留差异，不能视为批准版发布成功。
              </li>
            </ol>
            <Notice>
              复制文案或打开账号主页不会发布微博，也不会改变任务发布状态。发布后请在下方回填实际账号、正文和单条微博链接并人工确认。
              如已手动发布，请保存链接并避免重复发布。
            </Notice>
          </section>
        </>
      )}
    </>
  );
}
