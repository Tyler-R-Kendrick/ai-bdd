import { useEffect, useState } from 'react';
import { PanelsTopLeft, ArrowRight, GitBranch, LogIn } from 'lucide-react';
import { api } from '../lib.ts';
import { Button, Spinner } from './ui.tsx';

type SignInStatus = { github: boolean };

export function Login() {
  const callbackFailed =
    new URLSearchParams(location.search).get('signin') === 'failed';
  const [status, setStatus] = useState<SignInStatus | null>(null),
    [error, setError] = useState(''),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setStatus(null);
    setError('');
    api<SignInStatus>('/auth/status')
      .then((value) => {
        if (active) setStatus({ github: value.github === true });
      })
      .catch(() => {
        if (active)
          setError('We couldn’t check GitHub sign-in. Please try again.');
      });
    return () => {
      active = false;
    };
  }, [attempt]);
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
        <section className="login-form" aria-labelledby="sign-in-heading">
          <h2 id="sign-in-heading">Welcome back</h2>
          <p className="muted">
            Sign in with GitHub to continue working with your team.
          </p>
          {!status && !error ? (
            <Spinner label="Checking GitHub sign-in…" />
          ) : status?.github ? (
            <>
              {callbackFailed && (
                <p role="alert" className="error-text">
                  GitHub sign-in wasn’t completed. Please try again.
                </p>
              )}
              <Button asChild className="login-github w-full">
                <a href="/api/auth/github">
                  <LogIn size={18} />
                  Continue with GitHub
                  <ArrowRight size={16} />
                </a>
              </Button>
            </>
          ) : (
            <>
              <p role="alert" className="error-text">
                {error ||
                  'GitHub sign-in is temporarily unavailable. Please try again in a moment.'}
              </p>
              <Button
                variant="outline"
                className="w-full"
                onClick={() => setAttempt((value) => value + 1)}
              >
                Try again
              </Button>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
