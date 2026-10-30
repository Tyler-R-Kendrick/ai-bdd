import { z } from 'zod';
import { checkoutRegistrationSchema } from './account-machines.ts';
export const plannerLeaseMs = 60_000;
export const plannerIdleMs = 120_000;
export const plannerAssignmentStatusSchema = z.enum([
  'queued',
  'claimed',
  'idle',
  'stopped',
  'failed',
  'revoked',
  'stale',
]);
/** Configuration intent for the remote transport, never a claim about its actual ACP model. */
export const plannerProfileSchema = z
  .object({
    harness: z.literal('remote-planner'),
    provider: z.string().trim().min(1).max(100),
    model: z.string().trim().min(1).max(200),
  })
  .strict();
const epoch = z.number().int().positive(),
  time = z.string().datetime();
export const plannerAssignmentSchema = z
  .object({
    id: z.string().uuid(),
    deviceId: z.string().uuid(),
    artifactId: z.string().uuid(),
    projectId: z.string().uuid(),
    repository: checkoutRegistrationSchema.shape.repository,
    checkoutKey: checkoutRegistrationSchema.shape.checkoutKey,
    epoch,
    status: plannerAssignmentStatusSchema,
    artifactVersion: z.number().int().positive(),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    profile: plannerProfileSchema,
    expiresAt: time.nullable(),
    // A queued owner request has no running process or idle timer yet.
    idleExpiresAt: time.nullable(),
  })
  .strict();
export const plannerAssignmentRequestSchema = z
  .object({
    deviceId: z.string().uuid(),
    artifactVersion: z.number().int().positive(),
  })
  .strict();
export const plannerDeviceSchema = z
  .object({
    id: z.string().uuid(),
    label: z.string().max(200),
    status: z.enum(['available', 'busy', 'offline', 'unavailable']),
    reason: z.string().nullable(),
    checkoutKey: z.string().nullable(),
  })
  .strict();
export const plannerViewSchema = z
  .object({
    enabled: z.boolean(),
    devices: z.array(plannerDeviceSchema).max(200),
    assignment: plannerAssignmentSchema.nullable(),
    blockedByOtherWriter: z.boolean(),
  })
  .strict();
export const plannerPollRequestSchema = z
  .object({ checkouts: z.array(checkoutRegistrationSchema).max(100) })
  .strict();
export const plannerPollResponseSchema = z
  .object({ assignments: z.array(plannerAssignmentSchema).max(100) })
  .strict();
export const plannerClaimRequestSchema = z.object({ epoch }).strict();
export const plannerClaimSchema = plannerAssignmentSchema
  .omit({ id: true, status: true, deviceId: true })
  .extend({
    assignmentId: z.string().uuid(),
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    expiresAt: time,
    idleExpiresAt: time,
  })
  .strict();
export const plannerRenewRequestSchema = plannerClaimRequestSchema;
export const plannerRenewSchema = z
  .object({ expiresAt: time, idle: z.boolean() })
  .strict();
export const plannerReleaseRequestSchema = z
  .object({ epoch, reason: z.enum(['idle', 'stopped', 'failed']) })
  .strict();
export const plannerReleaseSchema = z.object({ ok: z.literal(true) }).strict();
export type PlannerAssignment = z.infer<typeof plannerAssignmentSchema>;
export type PlannerClaim = z.infer<typeof plannerClaimSchema>;
export type PlannerRenewal = z.infer<typeof plannerRenewSchema>;
export type PlannerView = z.infer<typeof plannerViewSchema>;
export type PlannerScope = {
  user: { id: string; name: string; email: string; color: string };
  artifactId: string;
  assignmentId: string;
  epoch: number;
};
