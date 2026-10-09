import { describe, expect, it } from 'vitest';
import { isNavigationAllowed } from '@ai-bdd/driver-playwright';
import { capabilitiesFromTools } from '@ai-bdd/driver-cua';

/** Attack 8: bypass allowHosts/allowApps (redirects, window.open, javascript:, data:, file:). */
const allowHosts = ['localhost', '127.0.0.1', '[::1]', 'example.test'];

describe('attack 8: policy bypass', () => {
  const denied = [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'blob:http://localhost/abc',
    'about:blank',
    'http://localhost@evil.test/',
    'http://evil.test/#localhost',
    'http://evil.test/?next=http://localhost',
    'http://localhost.evil.test/',
    'http://evil-localhost/',
    'https://notexample.test/',
    'http://127.0.0.1.evil.test/',
    'ftp://localhost/',
  ];
  for (const url of denied) {
    it(`denies ${url}`, () => {
      expect(isNavigationAllowed(url, allowHosts).allowed).toBe(false);
    });
  }

  const allowed = [
    'http://localhost/',
    'http://localhost:3000/settings/billing',
    'https://example.test/path',
    'https://app.example.test/path',
    'http://127.0.0.1:8080/x',
    '/settings/billing',
    'http://localhost./x',
    'http://LOCALHOST/x',
  ];
  for (const url of allowed) {
    it(`allows ${url}`, () => {
      expect(isNavigationAllowed(url, allowHosts, 'http://localhost:3000').allowed).toBe(true);
    });
  }

  it('denies the background-only verbs when the Cua allowlist is empty', () => {
    const catalog = ['list_apps', 'list_windows', 'get_window_state', 'click', 'verify_state', 'start_session', 'end_session'];
    const capabilities = capabilitiesFromTools(catalog, false);
    expect(capabilities.verbs).toContain('tap');
    expect(capabilities.verbs).not.toContain('navigate');
  });
});
