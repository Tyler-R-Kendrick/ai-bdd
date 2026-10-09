import { describe, expect, it } from 'vitest';
import { counterExampleGuard, numbersIn, polarityGuard } from '../../src/index.js';

interface GuardRow {
  step: string;
  binding: string;
  reject: 'polarity' | 'quantity' | 'number' | null;
}

// R-K5a-e guard table: >= 50 rows covering compatible, polarity, quantity and number cases.
const ROWS: GuardRow[] = [
  // compatible
  { step: 'the user opens the page', binding: 'the user opens the page', reject: null },
  { step: 'the user opens the page', binding: 'the user opens <page>', reject: null },
  { step: 'I have 3 cucumbers', binding: 'I have <count> cucumbers', reject: null },
  { step: 'the user is logged in', binding: 'the user is logged in', reject: null },
  { step: 'the list is empty', binding: 'the list is empty', reject: null },
  { step: 'the cart has at least 3 items', binding: 'the cart has at least <count> items', reject: null },
  { step: 'the cart has at most 5 items', binding: 'the cart has at most <count> items', reject: null },
  { step: 'the form shows exactly 2 errors', binding: 'the form shows exactly <count> errors', reject: null },
  { step: 'the user is not logged in', binding: 'the user is not logged in', reject: null },
  { step: 'no items are shown', binding: 'no items are shown', reject: null },
  { step: 'the plan is free', binding: 'the plan is free', reject: null },
  { step: 'I click the Save button', binding: 'I click the <label> button', reject: null },
  { step: 'the user deletes the project', binding: 'the user deletes the <name>', reject: null },
  { step: 'the total is 10.5', binding: 'the total is <amount>', reject: null },
  { step: 'the button appears', binding: 'the button appears', reject: null },
  { step: 'the user has more than 1 role', binding: 'the user has <count> roles', reject: null },
  { step: 'the user clicks 3 times', binding: 'the user clicks <count> times', reject: null },
  { step: 'the list is not empty', binding: 'the list is not empty', reject: null },
  { step: 'the form shows no errors', binding: 'the form shows no errors', reject: null },
  { step: 'the badge reads Pro', binding: 'the badge reads <plan>', reject: null },
  { step: 'the user types Acme', binding: 'the user types <company>', reject: null },
  { step: 'the dialog appears', binding: 'the dialog appears', reject: null },
  { step: 'the page loads', binding: 'the page loads', reject: null },
  { step: 'the user signs up', binding: 'the user signs up', reject: null },
  { step: 'the user logs in', binding: 'the user logs in', reject: null },
  { step: 'the user logs out', binding: 'the user logs out', reject: null },
  { step: 'I click the 3rd button', binding: 'I click the 3rd button', reject: null },
  { step: 'the total is 10', binding: 'the total is 10', reject: null },
  // polarity
  { step: 'the user is not logged in', binding: 'the user is logged in', reject: 'polarity' },
  { step: 'the user is logged in', binding: 'the user is not logged in', reject: 'polarity' },
  { step: 'no items are shown', binding: 'items are shown', reject: 'polarity' },
  { step: 'items are shown', binding: 'no items are shown', reject: 'polarity' },
  { step: 'the list is empty', binding: 'the list shows <count> items', reject: 'polarity' },
  { step: 'the user cannot sign in', binding: 'the user can sign in', reject: 'polarity' },
  { step: 'the field never validates', binding: 'the field validates', reject: 'polarity' },
  { step: 'the user deletes the file', binding: 'the user does not delete the file', reject: 'polarity' },
  { step: 'the cart is without items', binding: 'the cart has items', reject: 'polarity' },
  { step: 'the user fails to sign in', binding: 'the user signs in', reject: 'polarity' },
  { step: 'none of the items load', binding: 'the items load', reject: 'polarity' },
  { step: 'the dialog does not appear', binding: 'the dialog appears', reject: 'polarity' },
  { step: "the user isn't signed in", binding: 'the user is signed in', reject: 'polarity' },
  { step: "the value doesn't change", binding: 'the value changes', reject: 'polarity' },
  { step: "they don't have access", binding: 'they have access', reject: 'polarity' },
  // quantity
  { step: 'the cart has more than 3 items', binding: 'the cart has fewer than <count> items', reject: 'quantity' },
  { step: 'the cart has fewer than 3 items', binding: 'the cart has more than <count> items', reject: 'quantity' },
  { step: 'the cart has at least 3 items', binding: 'the cart has at most <count> items', reject: 'quantity' },
  { step: 'the list shows only 2 rows', binding: 'the list shows exactly <count> rows', reject: 'quantity' },
  { step: 'the total is exactly 5', binding: 'the total is more than <amount>', reject: 'quantity' },
  { step: 'the cart has less than 3 items', binding: 'the cart has at least <count> items', reject: 'quantity' },
  { step: 'the page shows at most 3 alerts', binding: 'the page shows at least <count> alerts', reject: 'quantity' },
  // number
  { step: 'I click the 3rd button', binding: 'I click the 5th button', reject: 'number' },
  { step: 'the total is 10', binding: 'the total is 20', reject: 'number' },
  { step: 'the list shows 2 rows', binding: 'the list shows 3 rows', reject: 'number' },
  { step: 'the user has 4 items', binding: 'the user has 2 items', reject: 'number' },
  { step: 'the cart has 1 item', binding: 'the cart has 2 items', reject: 'number' },
  { step: 'the page has 3 errors', binding: 'the page has 5 errors', reject: 'number' },
  { step: 'the price is 9.99', binding: 'the price is 19.99', reject: 'number' },
  { step: 'the total is -1', binding: 'the total is 1', reject: 'number' },
];

describe('polarityGuard (R-K5a-e)', () => {
  it('has a table with at least 50 rows', () => {
    expect(ROWS.length).toBeGreaterThanOrEqual(50);
  });

  it.each(ROWS)('step=$step binding=$binding -> $reject', ({ step, binding, reject }) => {
    const result = polarityGuard(step, binding);
    if (reject === null) {
      expect(result).toBeNull();
    } else {
      expect(result).toContain(reject);
    }
  });

  it('honours a custom negation token list', () => {
    expect(polarityGuard('the user skipped login', 'the user skipped login', { negationTokens: ['skipped'] })).toBeNull();
    expect(polarityGuard('the user skipped login', 'the user logged in', { negationTokens: ['skipped'] })).toContain('polarity');
  });

  it('can disable the number guard', () => {
    expect(polarityGuard('the total is 10', 'the total is 20', { numbers: false })).toBeNull();
  });
});

describe('counterExampleGuard (R-K5e)', () => {
  it('rejects a step equal to a declared counter-example, case-insensitively', () => {
    expect(counterExampleGuard('I have no items', { counterExamples: ['I have no items'] })).toContain('counter-example');
    expect(counterExampleGuard('I HAVE NO ITEMS.', { counterExamples: ['i have no items'] })).toContain('counter-example');
  });

  it('allows a step that is not a counter-example', () => {
    expect(counterExampleGuard('I have 3 items', { counterExamples: ['I have no items'] })).toBeNull();
    expect(counterExampleGuard('anything', {})).toBeNull();
  });
});

describe('numbersIn', () => {
  it('extracts integers and decimals including negatives', () => {
    expect(numbersIn('a 3 b -1 c 2.5')).toEqual([3, -1, 2.5]);
    expect(numbersIn('no numbers here')).toEqual([]);
  });
});
