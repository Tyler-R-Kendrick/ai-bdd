import { z } from 'zod';

export const agentPolicySchema = z
  .object({
    mode: z.enum(['manual', 'automatic']),
    paused: z.boolean(),
  })
  .strict();
export type AgentPolicy = z.infer<typeof agentPolicySchema>;
export const agentJobStates = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
] as const;
export type AgentJobState = (typeof agentJobStates)[number];
export type AgentJob = {
  id: string;
  artifactId: string;
  threadId: string;
  intent: 'chat' | 'edit' | 'research';
  brief: string;
  artifactVersion: number;
  status: AgentJobState;
  childArtifactId: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
};
export const researchSourceSchema = z
  .object({
    title: z.string().min(1).max(500),
    url: z
      .url()
      .max(2000)
      .refine((value) => new URL(value).protocol === 'https:'),
    excerpt: z.string().min(1).max(12000),
  })
  .strict();
export type ResearchSource = z.infer<typeof researchSourceSchema> & {
  sha256: string;
  retrievedAt: string;
};
export const designModes = ['cloud', 'local-codex', 'byok'] as const;
export type DesignMode = (typeof designModes)[number];
export type IntegrationCapabilities = {
  model: boolean;
  research: { provider: 'wikipedia' | 'gateway'; configured: boolean };
  repository: boolean;
  openDesign: { configured: boolean; modeRequiresExplicitSelection: true };
  machines: boolean;
};
