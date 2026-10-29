import { useEffect, useState } from 'react';
import { PanelsTopLeft, ArrowRight, GitBranch } from 'lucide-react';
import { api } from '../lib.ts';
import { Button, Field, Input, Spinner } from './ui.tsx';
import type { User } from '../../shared/domain.ts';
export function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [status, setStatus] = useState<any>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api('/auth/status')
      .then(setStatus)
      .catch((e) => setError(e.message));
  }, []);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true);
    setError('');
    try {
      onLogin(
        await api(status.setup ? '/auth/setup' : '/auth/login', 'POST', data),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-page">
      <div className="login-brand">
        <PanelsTopLeft size={24} />
        <strong>ai-bdd</strong>
        <span>Studio</span>
      </div>
      <div className="login-layout">
        <div className="login-intro">
          <h1>
            Make the plan.
            <br />
            Keep the proof.
          </h1>
          <p>
            A shared place for your ideas, artifacts, and the decisions that
            connect them.
          </p>
          <div className="login-trace">
            <GitBranch size={20} />
            <span>Document → build → test → evidence</span>
          </div>
        </div>
        <section className="login-form">
          <h2>{status?.setup ? 'Create your workspace' : 'Welcome back'}</h2>
          <p className="muted">
            {status?.setup
              ? 'Set up the first owner account.'
              : 'Sign in to continue working with your team.'}
          </p>
          {!status ? (
            <Spinner />
          ) : (
            <>
              <form onSubmit={submit}>
                {status.setup && (
                  <Field label="Your name">
                    <Input
                      name="name"
                      required
                      autoComplete="name"
                      maxLength={100}
                    />
                  </Field>
                )}
                <Field label="Email">
                  <Input
                    type="email"
                    name="email"
                    required
                    autoComplete="username"
                  />
                </Field>
                <Field
                  label={
                    status.setup
                      ? 'Password · at least 16 characters'
                      : 'Password'
                  }
                >
                  <Input
                    name="password"
                    type="password"
                    required
                    minLength={status.setup ? 16 : 1}
                    maxLength={256}
                    autoComplete={
                      status.setup ? 'new-password' : 'current-password'
                    }
                  />
                </Field>
                {error && (
                  <p role="alert" className="error-text">
                    {error}
                  </p>
                )}
                <Button disabled={busy} className="w-full">
                  {busy ? (
                    <Spinner label="Signing in…" />
                  ) : (
                    <>
                      {status.setup ? 'Create workspace' : 'Sign in'}
                      <ArrowRight size={16} />
                    </>
                  )}
                </Button>
              </form>
              {status.oidc && (
                <Button variant="outline" asChild className="w-full">
                  <a href="/api/auth/oidc">Continue with your organization</a>
                </Button>
              )}
              {status.demo && (
                <Button
                  variant="secondary"
                  className="w-full"
                  onClick={() => {
                    setBusy(true);
                    api<User>('/auth/demo', 'POST')
                      .then(onLogin)
                      .catch((e) => setError(e.message))
                      .finally(() => setBusy(false));
                  }}
                  disabled={busy}
                >
                  Open local demo
                </Button>
              )}
              {status.demo && (
                <p className="small muted">
                  Local development demo. Sample content is illustrative.
                </p>
              )}
            </>
          )}
        </section>
      </div>
    </main>
  );
}
