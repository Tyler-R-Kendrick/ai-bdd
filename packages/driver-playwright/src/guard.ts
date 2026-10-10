/**
 * Init script for contexts the driver owns: `window.open` to a URL that policy would deny returns `null` without
 * opening anything. Playwright cannot intercept the first request of a script-opened popup, so this keeps that request
 * from ever being sent. (Popups that still appear, for example from `target=_blank` links, are closed by the session.)
 */
export function windowOpenGuardScript(allowHosts: readonly string[]): string {
  return `(() => {
  const allow = ${JSON.stringify(allowHosts.map((h) => h.toLowerCase()))};
  const ok = (raw) => {
    try {
      const u = new URL(raw, location.href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      if (u.username !== '' || u.password !== '') return false;
      const h = u.hostname.toLowerCase();
      return allow.some((a) => (a.startsWith('*.') ? h.endsWith(a.slice(1)) : h === a));
    } catch (e) { return false; }
  };
  const open = window.open;
  window.open = function (url, ...rest) {
    if (url === undefined || url === null || url === '' || url === 'about:blank' || ok(String(url))) return open.call(this, url, ...rest);
    return null;
  };
})();`;
}
