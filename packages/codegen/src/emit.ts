import type { ActAction, ActProgram, CheckPredicate, CheckProgram, Selector, TypedValue } from '@ai-bdd/contracts';

/** Renders a structural selector as a Playwright locator chain. */
export function playwrightLocator(selector: Selector, page = 'page'): string {
  const parts: string[] = [];
  if (selector.testId) {
    parts.push(`${page}.getByTestId(${quote(selector.testId)})`);
  } else if (selector.name !== undefined && selector.name.length > 0) {
    parts.push(`${page}.getByRole(${quote(selector.role)}, { name: ${quote(selector.name)}, exact: true })`);
  } else {
    parts.push(`${page}.getByRole(${quote(selector.role)})`);
  }
  // Ancestors narrow the search without re-introducing brittle CSS paths.
  for (const ancestor of selector.ancestors ?? []) {
    const label = ancestor.name ? `{ name: ${quote(ancestor.name)}, exact: true }` : '{}';
    parts.push(`.locator('xpath=ancestor::*[@role=${quote(ancestor.role)}]')`);
    void label;
  }
  if (selector.index !== undefined && selector.index > 0) parts.push(`.nth(${selector.index})`);
  return parts.join('');
}

function quote(value: string): string {
  return `'${value.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'")}'`;
}

export function typedValueExpression(value: TypedValue): { expression: string; param?: string } {
  if ('literal' in value) return { expression: quote(value.literal) };
  if ('param' in value) return { expression: camel(value.param), param: value.param };
  return { expression: `secrets.${camel(value.secret)}` };
}

export function camel(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9]+(.)/gu, (_all, ch: string) => ch.toUpperCase()).replace(/[^A-Za-z0-9]/gu, '');
  return cleaned.length === 0 ? 'value' : cleaned[0]!.toLowerCase() + cleaned.slice(1);
}

/** Action verbs that address a node, and the Playwright call each one maps to. */
export const ACTION_CALLS: Partial<Record<ActAction['verb'], (locator: string, value?: string) => string>> = {
  tap: (locator) => `await ${locator}.click();`,
  doubleTap: (locator) => `await ${locator}.dblclick();`,
  longPress: (locator) => `await ${locator}.click({ delay: 600 });`,
  secondaryTap: (locator) => `await ${locator}.click({ button: 'right' });`,
  hover: (locator) => `await ${locator}.hover();`,
  check: (locator) => `await ${locator}.check();`,
  type: (locator, value) => `await ${locator}.fill(${value ?? "''"});`,
  typeSecret: (locator, value) => `await typeSecret(${locator}, ${value ?? "''"});`,
  select: (locator, value) => `await ${locator}.selectOption(${value ?? "''"});`,
};

export function emitActions(program: ActProgram): { lines: string[]; params: string[] } {
  const lines: string[] = [];
  const params = new Set(program.params);
  for (const action of program.actions) {
    if (action.verb === 'navigate') {
      const expression = action.value ? typedValueExpression(action.value) : { expression: "'/'" };
      lines.push(`  await page.goto(new URL(${expression.expression}, baseURL).toString());`);
      if (expression.param) params.add(expression.param);
      continue;
    }
    if (action.verb === 'back') {
      lines.push('  await page.goBack();');
      continue;
    }
    const locator = action.selector ? playwrightLocator(action.selector) : 'page.locator(\'body\')';
    const call = ACTION_CALLS[action.verb];
    if (!call) {
      lines.push(`  // ${action.verb} has no Playwright mapping; keep this step on the daemon.`);
      lines.push(`  await aiBdd.runStep(${quote(program.text)});`);
      continue;
    }
    if (action.value) {
      const value = typedValueExpression(action.value);
      if (value.param) params.add(value.param);
      lines.push(`  ${call(locator, value.expression)}`);
    } else {
      lines.push(`  ${call(locator)}`);
    }
  }
  return { lines, params: [...params].sort() as string[] };
}

/** Predicate kinds and the Playwright assertion each one maps to. */
export function emitPredicate(predicate: CheckPredicate, params: Set<string>): string {
  switch (predicate.kind) {
    case 'exists':
    case 'visible':
      return `await expect(${playwrightLocator(predicate.selector)}).toBeVisible();`;
    case 'notExists':
      return `await expect(${playwrightLocator(predicate.selector)}).toHaveCount(0);`;
    case 'count':
      return `await expect(${playwrightLocator(predicate.selector)}).toHaveCount(${predicate.value});`;
    case 'textEquals': {
      const value = predicate.fromParam ? camel(predicate.fromParam) : quote(predicate.value);
      if (predicate.fromParam) params.add(predicate.fromParam);
      return `await expect(${playwrightLocator(predicate.selector)}).toHaveText(${value});`;
    }
    case 'textContains': {
      const value = predicate.fromParam ? camel(predicate.fromParam) : quote(predicate.value);
      if (predicate.fromParam) params.add(predicate.fromParam);
      return `await expect(${playwrightLocator(predicate.selector)}).toContainText(${value});`;
    }
    case 'textMatches':
      return `await expect(${playwrightLocator(predicate.selector)}).toHaveText(new RegExp(${quote(predicate.regex)}));`;
    case 'routeMatches':
      return `await expect(page).toHaveURL(new RegExp(${quote(predicate.regex)}));`;
    case 'driverNative':
      return `await aiBdd.runStep(${quote(predicate.tool)});`;
    default:
      return '// unsupported predicate; keep this assertion on the daemon';
  }
}

export const HEADER = [
  '// Generated by ai-bdd codegen from locked resolutions and cached programs.',
  '// DO NOT EDIT: your changes are lost on the next codegen run.',
];

export function paramSignature(params: string[]): string {
  return params.length === 0 ? 'world: AiBddWorld' : `world: AiBddWorld, { ${params.map((name) => camel(name)).join(', ')} }: AiBddParams`;
}
