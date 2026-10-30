export const RECENT_AGENT_CHANGE_MS = 30_000;
export type DocumentAgentChange = {
  anchor: string;
  digest: string;
  version: number;
  actor: string;
  source: string;
  createdAt: string;
  expiresAt: number;
};
export type DocumentAgentChangeSource =
  | 'Accepted agent proposal'
  | 'Agent research update'
  | 'Applied investigation findings'
  | 'Agent goal seed';
