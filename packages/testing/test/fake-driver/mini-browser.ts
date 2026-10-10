import { Client } from '../app/client.ts';
import { parseHtml, toAxNodes, type AxNode } from '../app/html-parse.ts';

/**
 * A just-enough "browser" over the real HTTP server: GET pages, fill inputs, click links and buttons by
 * accessible name, submit forms the way a browser would (all current field values + the pressed button).
 */
interface Raw {
  tag: string;
  attrs: Record<string, string>;
  children: (Raw | string)[];
}

const walk = (el: Raw, visit: (e: Raw) => void): void => {
  visit(el);
  for (const c of el.children) if (typeof c !== 'string') walk(c, visit);
};
const text = (el: Raw | string): string => (typeof el === 'string' ? el : el.children.map(text).join(''));

export class MiniBrowser {
  private readonly client: Client;
  private html = '';
  route = '';
  private typed = new Map<string, string>();

  constructor(base: string) {
    this.client = new Client(base);
  }

  async goto(path: string): Promise<void> {
    const res = await this.client.get(path);
    this.html = res.text;
    const u = new URL(res.url);
    this.route = u.pathname + u.search;
    this.typed = new Map();
  }

  private elements(): Raw[] {
    const out: Raw[] = [];
    walk(parseHtml(this.html) as Raw, (e) => out.push(e));
    return out;
  }

  fill(name: string, value: string, nth = 0): void {
    const input = this.elements().filter((e) => e.tag === 'input' && e.attrs['aria-label'] === name)[nth];
    if (input === undefined) throw new Error(`no textbox ${name}`);
    this.typed.set(input.attrs['name'] ?? '', value);
  }

  async clickLink(name: string): Promise<void> {
    const a = this.elements().find((e) => e.tag === 'a' && text(e).trim() === name);
    if (a === undefined) throw new Error(`no link ${name}`);
    await this.goto(a.attrs['href'] ?? '/');
  }

  async clickButton(name: string, nth = 0): Promise<void> {
    const els = this.elements();
    const btn = els.filter((e) => e.tag === 'button' && text(e).trim() === name)[nth];
    if (btn === undefined) throw new Error(`no button ${name}`);
    await this.submit(els, btn);
  }

  /** Implicit submission (Enter in a text field) uses the first submit button. */
  async pressEnter(): Promise<void> {
    const els = this.elements();
    const btn = els.find((e) => e.tag === 'button' && e.attrs['type'] === 'submit');
    if (btn === undefined) return;
    await this.submit(els, btn);
  }

  private async submit(els: Raw[], btn: Raw): Promise<void> {
    const fields: Record<string, string> = {};
    for (const e of els) {
      if (e.tag !== 'input') continue;
      const name = e.attrs['name'];
      if (name === undefined || name === '') continue;
      fields[name] = this.typed.get(name) ?? e.attrs['value'] ?? '';
    }
    fields['__action'] = btn.attrs['value'] ?? '';
    const res = await this.client.post('/__act', fields);
    this.html = res.text;
    const u = new URL(res.url);
    this.route = u.pathname + u.search;
    this.typed = new Map();
  }

  nodes(): AxNode[] {
    return toAxNodes(this.html);
  }
}
