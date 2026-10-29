import { useEffect, useState } from 'react';
import { Copy, KeyRound, Trash2 } from 'lucide-react';
import { api } from '../lib.ts';
import {
  Button,
  Field,
  Input,
  Select,
  Modal,
  Badge,
  IconButton,
} from './ui.tsx';
import type { Project } from '../../shared/domain.ts';
export function ShareDialog({
  open,
  onOpenChange,
  project,
  onError,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  project: Project;
  onError: (e: string) => void;
}) {
  const [members, setMembers] = useState<any[]>([]),
    [secret, setSecret] = useState(''),
    [busy, setBusy] = useState(false),
    [token, setToken] = useState('');
  const refresh = () => api(`/projects/${project.id}/members`).then(setMembers);
  useEffect(() => {
    if (open) {
      refresh().catch((e) => onError(e.message));
      setSecret('');
      setToken('');
    }
  }, [open, project.id]);
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Share this project"
      description="Project members can access its artifacts, discussions, decisions, and evidence."
    >
      <div className="member-list">
        {members.map((m) => (
          <div className="member-row" key={m.id}>
            <span className="avatar" style={{ background: m.color }}>
              {m.name[0]}
            </span>
            <span>
              {m.name}
              <small>{m.email}</small>
            </span>
            <Badge>{m.role}</Badge>
            {project.role === 'owner' && (
              <IconButton
                label={`Remove ${m.name}`}
                onClick={() =>
                  api(`/projects/${project.id}/members/${m.id}`, 'DELETE')
                    .then(refresh)
                    .catch((e) => onError(e.message))
                }
              >
                <Trash2 size={14} />
              </IconButton>
            )}
          </div>
        ))}
      </div>
      {project.role === 'owner' && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const b = Object.fromEntries(new FormData(e.currentTarget));
              const result = await api(
                `/projects/${project.id}/members`,
                'POST',
                b,
              );
              setSecret(result.temporaryPassword ?? '');
              await refresh();
            } catch (e) {
              onError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Teammate's email">
            <Input type="email" name="email" required />
          </Field>
          <div className="form-row">
            <Field label="Name">
              <Input name="name" required maxLength={100} />
            </Field>
            <Field label="Access">
              <Select name="role" defaultValue="editor">
                <option value="editor">Editor</option>
                <option value="viewer">Viewer</option>
                <option value="owner">Owner</option>
              </Select>
            </Field>
          </div>
          <Button disabled={busy}>Add or update member</Button>
          {secret && (
            <div className="secret-box">
              <strong>Temporary password</strong>
              <code>{secret}</code>
              <p className="small">
                Share this password through a secure channel. No invitation
                email was sent.
              </p>
            </div>
          )}
        </form>
      )}
      <div className="settings-section">
        <h3>Connect an agent over MCP</h3>
        <p className="small muted">
          Create a personal API token for the Studio MCP adapter. It expires
          after 30 days and has your project permissions.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            api('/tokens', 'POST')
              .then((r) => setToken(r.token))
              .catch((e) => onError(e.message))
          }
        >
          <KeyRound size={14} />
          Create API token
        </Button>
        {token && (
          <div className="secret-box">
            <code>{token}</code>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                navigator.clipboard
                  .writeText(token)
                  .catch(() =>
                    onError(
                      'Copy the token manually; clipboard access was denied.',
                    ),
                  )
              }
            >
              <Copy size={14} />
              Copy token
            </Button>
            <p className="small">Shown once. Store securely.</p>
          </div>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            api('/tokens', 'DELETE')
              .then(() => {
                setToken('');
              })
              .catch((e) => onError(e.message))
          }
        >
          Revoke all my API tokens
        </Button>
      </div>
    </Modal>
  );
}
