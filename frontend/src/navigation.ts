export function navigate(to: string, replace = false) {
  if (replace) window.history.replaceState({}, '', to);
  else window.history.pushState({}, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function loginDestination(search: string) {
  const next = new URLSearchParams(search).get('next');
  if (!next) return '/tasks';
  let url: URL;
  try {
    url = new URL(next, window.location.origin);
  } catch {
    return '/tasks';
  }
  if (url.origin !== window.location.origin || url.pathname === '/login') return '/tasks';
  if (
    ['/', '/tasks', '/tasks/new', '/memories', '/evaluations', '/settings'].includes(
      url.pathname,
    ) ||
    /^\/tasks\/[A-Za-z0-9_-]+$/.test(url.pathname) ||
    /^\/previews\/tasks\/[A-Za-z0-9_-]+$/.test(url.pathname) ||
    /^\/evaluations\/[A-Za-z0-9_-]+\/blind$/.test(url.pathname)
  )
    return url.pathname + url.search + url.hash;
  return '/tasks';
}
