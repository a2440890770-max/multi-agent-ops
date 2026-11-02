import { createHash } from 'node:crypto';
import type { OperationBodies, PublishOperation } from '@multi-agent-ops/shared';
import { AuthError } from './auth.js';

// Supported single-post links. A UID homepage is never publication evidence.
export function weiboPost(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AuthError(422, 'VALIDATION_ERROR', '请填写有效的微博单条链接。');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port)
    throw new AuthError(422, 'VALIDATION_ERROR', '微博单条链接必须使用 HTTPS。');
  const desktop = ['weibo.com', 'www.weibo.com'].includes(url.hostname)
    ? /^\/([1-9][0-9]{0,19})\/([A-Za-z0-9]{1,128})\/?$/.exec(url.pathname)
    : null;
  const mobile =
    url.hostname === 'm.weibo.cn'
      ? /^\/(?:detail|status)\/([A-Za-z0-9]{1,128})\/?$/.exec(url.pathname)
      : null;
  if (!desktop && !mobile)
    throw new AuthError(
      422,
      'VALIDATION_ERROR',
      '请提供 weibo.com/<UID>/<微博标识> 或 m.weibo.cn/detail/<微博标识> 的单条链接，不能使用账号主页或外站链接。',
    );
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/$/, '');
  if (url.hostname === 'www.weibo.com') url.hostname = 'weibo.com';
  return { url: url.href, uid: desktop?.[1] ?? null, postId: (desktop?.[2] ?? mobile?.[1])! };
}
export function observation(
  body: OperationBodies['backfillPublication'],
  operation: PublishOperation,
) {
  if (!body.note.trim())
    throw new AuthError(422, 'VALIDATION_ERROR', '请填写核对说明或未发布原因。');
  const link = body.url ? weiboPost(body.url) : null;
  const observedBody = body.observedBody ?? null;
  const observedHash =
    observedBody === null ? null : createHash('sha256').update(observedBody, 'utf8').digest('hex');
  if (body.observedContentHash && body.observedContentHash !== observedHash)
    throw new AuthError(422, 'VALIDATION_ERROR', '实际正文摘要与服务端计算结果不一致。');
  if (body.platformPostId && body.platformPostId !== link?.postId)
    throw new AuthError(422, 'VALIDATION_ERROR', '微博标识与单条链接不一致。');
  if (
    body.conclusion === 'published' &&
    (!link || !body.observedAccountUid || observedBody === null || !observedBody.trim())
  )
    throw new AuthError(
      422,
      'VALIDATION_ERROR',
      '确认发布需提供微博单条链接、实际账号 UID 和完整实际正文。',
    );
  if (
    body.conclusion === 'not_published' &&
    (!body.manualConfirmed || !body.previousDispatchFenced)
  )
    throw new AuthError(
      422,
      'VALIDATION_ERROR',
      '确认未发布须明确核实未发布，并确认原交接已停止、不会继续发布。',
    );
  const differences: string[] = [];
  if (
    body.observedAccountUid &&
    body.observedAccountUid !== operation.snapshot.account.platformAccountId
  )
    differences.push('实际发布账号 UID 与冻结账号不一致。');
  if (link?.uid && link.uid !== operation.snapshot.account.platformAccountId)
    differences.push('单条微博链接中的账号 UID 与冻结账号不一致。');
  if (link?.uid && body.observedAccountUid && link.uid !== body.observedAccountUid)
    differences.push('单条链接中的账号 UID 与填写的实际账号不一致。');
  if (
    observedBody !== null &&
    (observedHash !== operation.contentHash || observedBody !== operation.snapshot.content.body)
  )
    differences.push('实际正文与批准原文不一致（包括空格和换行）。');
  if (body.conclusion === 'published' && !body.manualConfirmed)
    differences.push('尚未完成人工核对确认。');
  if (
    body.conclusion === 'not_published' &&
    (link || observedBody !== null || body.observedAccountUid)
  )
    differences.push('未发布声明同时包含发布观察资料，需进一步核实。');
  if (operation.status === 'published') {
    const current = operation.dispatches.find((d) => d.id === operation.currentDispatchId)!;
    if (body.conclusion !== 'published')
      differences.push('本次结论与已有成功发布事实矛盾，保留原成功状态。');
    if (link && link.url !== current.url)
      differences.push('本次链接与已确认的成功发布链接不一致。');
  }
  const conclusion =
    body.conclusion === 'unknown' || differences.length ? 'unknown' : body.conclusion;
  const status =
    operation.status === 'published'
      ? 'published'
      : conclusion === 'published'
        ? 'published'
        : conclusion === 'not_published'
          ? 'failed'
          : 'verification_required';
  return {
    link,
    observedBody,
    observedHash,
    conclusion,
    status,
    mismatchNote: differences.length ? differences.join('\n') : null,
  } as const;
}
