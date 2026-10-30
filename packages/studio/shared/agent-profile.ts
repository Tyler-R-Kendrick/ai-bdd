import { z } from 'zod';
const identifier = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => [...value].every((character) => {
    const code=character.charCodeAt(0);
    return code > 32 && code !== 127;
  }));
export const agentProfileSchema = z
  .object({
    harness: z.enum(['t3-code', 'local-cpu', 'vercel-fx', 'remote-planner']),
    provider: identifier.max(100),
    model: identifier,
  })
  .strict();
export type AgentProfile = z.infer<typeof agentProfileSchema>;
export type AgentProfileView = {
  profile: AgentProfile;
  defaultHarness: 't3-code';
  requiresExplicitFallback: true;
  harnesses: {
    id: AgentProfile['harness'];
    label: string;
    configured: boolean;
    reason: string | null;
    providers: { id: string; label: string; models: string[] }[];
  }[];
};
