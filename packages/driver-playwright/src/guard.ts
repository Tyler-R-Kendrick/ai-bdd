/**
 * Init script that keeps navigations the policy would deny from ever sending their first request. Playwright cannot
 * intercept the first request of a popup (the popup's target is created, and starts loading, before the session
 * learns about it), so the page itself refuses to open it:
 *
 * - `window.open` to a denied URL returns `null` without opening anything;
 * - capture-phase `click` / `auxclick` listeners cancel anchor and image-map activations that would open a new
 *   browsing context (`target` other than `_self` / `_parent` / `_top`, an inherited `<base target>`, a named window,
 *   a middle click or a ctrl / meta / shift click) when the resolved URL is denied;
 * - a capture-phase `submit` listener and a patched `HTMLFormElement.prototype.submit` do the same for forms
 *   (`target`, `formtarget`, `action`, `formaction`).
 *
 * Same-context navigations (`target=_self`, location assignments, redirects) are not handled here: they are vetted by
 * the session's route / CDP Fetch guards before any request leaves the browser. Popups that still appear (for example
 * a race with an event this script does not see) are closed by the session's popup vetting and sweeper.
 *
 * The script is idempotent and honours `window.__aiBddGuardOff = true`, which `sessionFromPage` sets when the borrowed
 * page is released.
 */
export function windowOpenGuardScript(allowHosts: readonly string[]): string {
  return `(() => {
  if (window.__aiBddGuardInstalled) return;
  try { Object.defineProperty(window, '__aiBddGuardInstalled', { value: true }); } catch (e) { return; }
  const allow = ${JSON.stringify(allowHosts.map((h) => h.toLowerCase()))};
  const ok = (raw, base) => {
    try {
      const u = new URL(raw, base || document.baseURI || location.href);
      if (u.href === 'about:blank') return true;
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      if (u.username !== '' || u.password !== '') return false;
      const h = u.hostname.toLowerCase();
      return allow.some((a) => (a.startsWith('*.') ? h.endsWith(a.slice(1)) : h === a));
    } catch (e) { return false; }
  };
  const off = () => window.__aiBddGuardOff === true;
  const SELF = ['', '_self', '_parent', '_top'];
  const opensNewContext = (target) => {
    const t = String(target || '').toLowerCase();
    return !SELF.includes(t);
  };
  const baseTarget = () => {
    const b = document.querySelector('base[target]');
    return b ? b.getAttribute('target') : '';
  };
  const open = window.open;
  window.open = function (url, ...rest) {
    if (off() || url === undefined || url === null || url === '' || url === 'about:blank' || ok(String(url))) return open.call(this, url, ...rest);
    return null;
  };
  const linkOf = (ev) => {
    const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
    for (const el of path) {
      if (el && el.nodeType === 1 && typeof el.matches === 'function' && el.matches('a[href], area[href]')) return el;
    }
    return null;
  };
  const onActivate = (ev) => {
    if (off()) return;
    const el = linkOf(ev);
    if (el === null) return;
    const href = el.getAttribute('href');
    if (href === null) return;
    const own = el.getAttribute('target');
    const target = own !== null && own !== '' ? own : baseTarget();
    const newContext = ev.type === 'auxclick' || ev.ctrlKey === true || ev.metaKey === true || ev.shiftKey === true || opensNewContext(target) || el.hasAttribute('download');
    if (!newContext || ok(href)) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
  };
  window.addEventListener('click', onActivate, true);
  window.addEventListener('auxclick', onActivate, true);
  const formBlocked = (form, submitter) => {
    const sub = submitter && typeof submitter.getAttribute === 'function' ? submitter : null;
    const fa = sub ? sub.getAttribute('formaction') : null;
    const ft = sub ? sub.getAttribute('formtarget') : null;
    const action = fa !== null ? fa : (form.getAttribute('action') || location.href);
    const own = ft !== null && ft !== '' ? ft : form.getAttribute('target');
    const target = own !== null && own !== '' ? own : baseTarget();
    return opensNewContext(target) && !ok(action);
  };
  window.addEventListener('submit', (ev) => {
    if (off()) return;
    const form = ev.target;
    if (!form || form.nodeType !== 1 || typeof form.getAttribute !== 'function') return;
    if (formBlocked(form, ev.submitter)) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
    }
  }, true);
  const submit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function () {
    if (!off() && formBlocked(this, null)) return;
    return submit.call(this);
  };
})();`;
}
