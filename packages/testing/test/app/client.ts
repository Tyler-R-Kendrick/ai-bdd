/** Minimal cookie-jar HTTP client for tests (fetch with manual redirects). */
export class Client {
  private cookie = '';
  constructor(private readonly base: string) {}

  async req(method: string, path: string, init: { headers?: Record<string, string>; body?: string; follow?: boolean } = {}): Promise<{ status: number; text: string; headers: Headers; url: string }> {
    let url = new URL(path, this.base).toString();
    let m = method;
    let body = init.body;
    for (let hops = 0; hops < 6; hops += 1) {
      const res = await fetch(url, {
        method: m,
        redirect: 'manual',
        headers: { ...(this.cookie ? { cookie: this.cookie } : {}), ...(init.headers ?? {}) },
        ...(body === undefined ? {} : { body }),
      });
      const set = res.headers.getSetCookie();
      for (const c of set) {
        const pair = c.split(';')[0] ?? '';
        const name = pair.split('=')[0] ?? '';
        const others = this.cookie.split('; ').filter((x) => x && !x.startsWith(`${name}=`));
        this.cookie = [...others, pair].join('; ');
      }
      const loc = res.headers.get('location');
      if (init.follow === true && loc !== null && res.status >= 300 && res.status < 400) {
        url = new URL(loc, url).toString();
        m = 'GET';
        body = undefined;
        continue;
      }
      return { status: res.status, text: await res.text(), headers: res.headers, url };
    }
    throw new Error('too many redirects');
  }

  get(path: string, follow = true) {
    return this.req('GET', path, { follow });
  }

  post(path: string, fields: Record<string, string>, follow = true) {
    return this.req('POST', path, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
      follow,
    });
  }

  json(path: string, body: unknown, headers: Record<string, string> = {}) {
    return this.req('POST', path, { headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  }

  get sid(): string {
    return this.cookie;
  }
}
