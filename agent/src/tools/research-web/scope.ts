import { isIP } from 'node:net';
import {
  OfficialSiteGrantSchema,
  type OfficialSiteGrant,
  type ResearchContext,
} from '@multi-agent-ops/shared';
import { ResearchWebError } from './config.js';

const platforms = {
  bilibili: ['bilibili.com', 'b23.tv'],
  xiaohongshu: ['xiaohongshu.com', 'xhslink.com'],
  douyin: ['douyin.com', 'iesdouyin.com'],
} as const;
export function canonicalWebUrl(value: string): string {
  if (value.length > 8192) throw new ResearchWebError('URL_TOO_LONG');
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new ResearchWebError('URL_INVALID');
  }
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    u.port ||
    isIP(u.hostname) ||
    u.hostname.endsWith('.') ||
    u.hostname === 'localhost' ||
    !u.hostname.includes('.') ||
    /%(?:2f|5c|00)/i.test(u.pathname)
  )
    throw new ResearchWebError('URL_NOT_ALLOWED');
  u.hash = '';
  return u.href;
}
const inPath = (path: string, prefix: string) =>
  prefix === '/' ||
  path === prefix.replace(/\/$/, '') ||
  path.startsWith(`${prefix.replace(/\/$/, '')}/`);

export function createWebScope(context: ResearchContext, grants: OfficialSiteGrant[]) {
  const repository = new URL(canonicalWebUrl(context.selectedProject.repositoryUrl));
  const repoPath = repository.pathname.replace(/\/$/, '');
  const verified = grants.map((raw) => {
    const grant = OfficialSiteGrantSchema.parse(raw);
    const u = new URL(canonicalWebUrl(grant.origin));
    if (
      u.origin !== grant.origin ||
      !grant.pathPrefix.startsWith('/') ||
      new URL(grant.pathPrefix, u.origin).pathname !== grant.pathPrefix ||
      grant.pathPrefix.includes('?') ||
      grant.pathPrefix.includes('#')
    )
      throw new ResearchWebError('OFFICIAL_GRANT_INVALID');
    return { ...grant, host: u.hostname };
  });
  function official(url: string) {
    const u = new URL(canonicalWebUrl(url));
    return (
      (u.hostname === 'github.com' && inPath(u.pathname, repoPath)) ||
      (u.hostname === 'raw.githubusercontent.com' && inPath(u.pathname, repoPath)) ||
      verified.some((g) => u.origin === g.origin && inPath(u.pathname, g.pathPrefix))
    );
  }
  function platform(url: string) {
    const host = new URL(canonicalWebUrl(url)).hostname;
    for (const [site, domains] of Object.entries(platforms))
      if (domains.some((d) => host === d || host.endsWith(`.${d}`)))
        return site as keyof typeof platforms;
    return null;
  }
  function readable(url: string) {
    // A submitted URL is a clue, never an implicit grant for another website.
    return official(url) || platform(url) !== null;
  }
  function search(input: unknown) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new ResearchWebError('SEARCH_INPUT_INVALID');
    const obj = input as Record<string, unknown>;
    if (
      Object.keys(obj).some((k) => !['query', 'allowed_domains', 'blocked_domains'].includes(k)) ||
      typeof obj.query !== 'string' ||
      !obj.query.trim() ||
      obj.query.length > 2000
    )
      throw new ResearchWebError('SEARCH_INPUT_INVALID');
    const query = obj.query;
    const declared = obj.allowed_domains;
    const embedded = [...query.matchAll(/\bsite:([^\s)]+)/gi)].map((m) => m[1]!);
    if (
      declared !== undefined &&
      (!Array.isArray(declared) || !declared.every((x) => typeof x === 'string'))
    )
      throw new ResearchWebError('SEARCH_DOMAINS_INVALID');
    const domains = (declared as string[] | undefined) ?? embedded;
    if (!domains.length || domains.length > 10 || !embedded.every((d) => domains.includes(d)))
      throw new ResearchWebError('SEARCH_SCOPE_REQUIRED');
    const officialHosts = [
      'github.com',
      'raw.githubusercontent.com',
      ...verified.map((g) => g.host),
    ];
    if (
      domains.some(
        (d) =>
          !officialHosts.includes(d) &&
          !Object.values(platforms).some((ds) => ds.some((p) => d === p || d.endsWith(`.${p}`))),
      )
    )
      throw new ResearchWebError('SEARCH_DOMAIN_DENIED');
    // Official searches must target the selected repository, not another candidate.
    const repoName = repoPath.slice(1).toLowerCase();
    const name = repoName.split('/').at(-1)!;
    if (!query.toLowerCase().includes(repoName) && !query.toLowerCase().includes(name))
      throw new ResearchWebError('SEARCH_PROJECT_REQUIRED');
    const site = Object.entries(platforms).find(([, ds]) =>
      domains.every((d) => ds.some((p) => d === p || d.endsWith(`.${p}`))),
    )?.[0] as keyof typeof platforms | undefined;
    return {
      input: { query, allowed_domains: [...new Set(domains)] },
      site: site ?? null,
      domains,
    };
  }
  return { official, platform, readable, search, canonical: canonicalWebUrl };
}
