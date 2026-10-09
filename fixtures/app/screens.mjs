/**
 * The single screen definition module. Both the HTTP server (server.mjs) and the
 * fake driver model (build-model.mjs -> model.json) are derived from it, so both
 * describe identical UIs (section 14.3 parity test).
 *
 * A screen owns its route pattern, its nodes and its transitions. Node names are
 * plain strings; `{{plan}}`-style placeholders are resolved from state.
 */

export const initial = { workspace: null, plan: 'free', unpaid: 0, now: null, toast: null, dialog: null, signedIn: false };

export const screens = [
  {
    route: '/settings/billing',
    title: 'Billing settings',
    nodes: [
      { role: 'heading', name: 'Billing settings' },
      { role: 'text', name: 'Plan: {{planLabel}}' },
      { role: 'text', name: 'Workspace: {{workspaceLabel}}' },
      { role: 'button', name: 'Upgrade to Pro', testId: 'upgrade', transition: { dialog: 'upgrade' } },
      { role: 'button', name: 'Downgrade', testId: 'downgrade', transition: { action: 'downgrade' } },
      { role: 'text', name: 'Prorated amount: {{prorated}}', testId: 'prorated', visibleWhen: 'plan:pro' },
      { role: 'alert', name: 'Downgrade is blocked: settle unpaid invoices first', testId: 'blocked', visibleWhen: 'blocked' }
    ],
    dialogs: {
      upgrade: [
        { role: 'dialog', name: 'Upgrade to Pro' },
        { role: 'text', name: 'You are upgrading to the Pro plan' },
        { role: 'button', name: 'Confirm upgrade', testId: 'confirmUpgrade', transition: { action: 'upgrade' } },
        { role: 'button', name: 'Cancel', testId: 'cancelUpgrade', transition: { dialog: null } }
      ]
    }
  },
  {
    route: '/forms/two',
    title: 'Two forms',
    nodes: [
      { role: 'heading', name: 'Two forms' },
      { role: 'form', name: 'Shipping form' },
      { role: 'button', name: 'Submit', testId: 'submit-shipping', ancestors: [{ role: 'form', name: 'Shipping form' }], transition: { toast: 'shipping-submitted' } },
      { role: 'form', name: 'Billing form' },
      { role: 'button', name: 'Submit', testId: 'submit-billing', ancestors: [{ role: 'form', name: 'Billing form' }], transition: { toast: 'billing-submitted' } }
    ]
  },
  {
    route: '/slow',
    title: 'Slow screen',
    nodes: [
      { role: 'heading', name: 'Slow screen' },
      { role: 'text', name: 'Loading…', testId: 'spinner', visibleWhen: 'loading' },
      { role: 'text', name: 'Slow content is ready', testId: 'slowContent', visibleWhen: 'loaded' }
    ],
    spinnerMs: 1000
  },
  {
    route: '/login',
    title: 'Sign in',
    nodes: [
      { role: 'heading', name: 'Sign in' },
      { role: 'textbox', name: 'User name', testId: 'user' },
      { role: 'textbox', name: 'Password', testId: 'password', secret: true },
      { role: 'button', name: 'Sign in', testId: 'signIn', transition: { action: 'signIn' } }
    ]
  },
  {
    route: '/dashboard',
    title: 'Dashboard',
    nodes: [
      { role: 'heading', name: 'Dashboard', testId: 'dashboardHeading' },
      { role: 'text', name: 'Welcome, {{user}}' }
    ]
  },
  {
    route: '/clock',
    title: 'Clock',
    nodes: [
      { role: 'heading', name: 'Clock' },
      { role: 'text', name: 'Server time: {{now}}', testId: 'clock' }
    ]
  },
  {
    route: '/toast',
    title: 'Toast',
    nodes: [
      { role: 'heading', name: 'Toast' },
      { role: 'alert', name: 'Something went wrong', testId: 'errorToast', visibleWhen: 'toast:error' }
    ]
  }
];

export function findScreen(pathname) {
  return screens.find((screen) => screen.route === pathname) ?? null;
}
