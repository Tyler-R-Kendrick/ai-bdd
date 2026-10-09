import { normalizeStepText } from './helpers.js';

export interface TemplateMatch {
  /** Parameter name to captured value, in template order. */
  params: Record<string, string>;
  /** Captured values in template order. */
  values: string[];
  /** Raw captured spans (before unquoting), in template order. */
  spans: string[];
}

export interface TemplateMatcher {
  template: string;
  regex: RegExp;
  parameters: string[];
  match(text: string): TemplateMatch | null;
  render(values: Record<string, string>): string;
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** Strip surrounding double quotes and resolve the documented escapes. */
export function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    const inner = value.slice(1, -1);
    return inner.replace(/\\(["\\ntr])/gu, (_m, ch: string) => {
      switch (ch) {
        case 'n':
          return '\n';
        case 't':
          return '\t';
        case 'r':
          return '\r';
        default:
          return ch;
      }
    });
  }
  return value;
}

export function templateToRegexSource(template: string): { source: string; parameters: string[] } {
  const parameters: string[] = [];
  let source = '';
  let index = 0;
  const re = /<([^<>]+)>/gu;
  let match: RegExpExecArray | null;
  while ((match = re.exec(template)) !== null) {
    source += escapeRegExp(template.slice(index, match.index));
    const name = match[1] ?? '';
    if (/^(file|table|secret):/u.test(name)) {
      // Special parameters are opaque and never act as wildcard captures.
      source += escapeRegExp(match[0] ?? '');
    } else {
      parameters.push(name);
      source += '("(?:[^"\\\\]|\\\\.)*"|<[^>]+>|\\S+)';
    }
    index = match.index + match[0].length;
  }
  source += escapeRegExp(template.slice(index));
  return { source: `^${source}$`, parameters };
}

/**
 * Convert a Gauge `<param>` template into an anchored matcher that captures
 * each parameter. Shared by concept expansion (P9) and Gauge-style bindings.
 */
export function gaugeTemplateToRegExp(template: string): TemplateMatcher {
  const { source, parameters } = templateToRegexSource(template);
  const regex = new RegExp(source, 'u');
  return {
    template,
    regex,
    parameters,
    match(text: string): TemplateMatch | null {
      const result = regex.exec(normalizeStepText(text));
      if (result === null) return null;
      const spans = result.slice(1).map((value) => value ?? '');
      const values = spans.map(unquote);
      const params: Record<string, string> = {};
      parameters.forEach((name, i) => {
        params[name] = values[i] ?? '';
      });
      return { params, values, spans };
    },
    render(values: Record<string, string>): string {
      return renderTemplate(template, values);
    },
  };
}

export function matchTemplate(template: string, text: string): TemplateMatch | null {
  return gaugeTemplateToRegExp(template).match(text);
}

export function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/<([^<>]+)>/gu, (whole, name: string) => values[name] ?? whole);
}
