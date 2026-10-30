import { z } from 'zod';
const identifier = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !/[\u0000-\u0020\u007f]/.test(value));
export const agentProfileSchema = z
  .object({
    harness: z.enum(['t3-code', 'vercel-fx', 'remote-planner']),
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
