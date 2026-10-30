import { z } from 'zod';
export const checkoutRegistrationSchema = z
  .object({
    checkoutKey: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
    repository: z
      .string()
      .regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    branch: z.string().max(200),
  })
  .strict();
export const accountCredentialsSchema = z
  .object({
    scope: z.literal('account'),
    id: z.string().uuid(),
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    expiresAt: z.string(),
    origin: z.string(),
  })
  .strict();
export type AccountMachineCredentials = z.infer<
  typeof accountCredentialsSchema
>;
export type CheckoutRegistration = z.infer<typeof checkoutRegistrationSchema>;
export const accountMachineTrust =
  'This machine can run work you approve in projects where you currently have write access, using only the checkouts you explicitly register. It never runs another member’s work. Each project keeps its own authorization and revocation. Automatic prototypes require separate explicit consent.';
