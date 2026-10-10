import type { ExitCode } from '@ai-bdd/sdk/contracts';
import { AiBddError } from '@ai-bdd/sdk/contracts';
import { withEngine, type Ctx } from '../context.ts';
import { asAiBddError, exitCodeForError } from '../exit.ts';

export const REVIEW_ACTIONS = ['accept', 'reject', 'pin', 'unpin'] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

const PAST: Record<ReviewAction, string> = { accept: 'accepted', reject: 'rejected', pin: 'pinned', unpin: 'unpinned' };

export function parseReviewAction(a: string): ReviewAction {
  if ((REVIEW_ACTIONS as readonly string[]).includes(a)) return a as ReviewAction;
  throw new AiBddError('USAGE', `Unknown review action "${a}". Expected one of: ${REVIEW_ACTIONS.join(', ')}.`);
}

export async function runReview(ctx: Ctx, actionArg: string, ids: string[]): Promise<ExitCode> {
  const action = parseReviewAction(actionArg);
  return withEngine(ctx, {}, async ({ engine }) => {
    let exit: ExitCode = 0;
    for (const id of ids) {
      try {
        await engine.review(id, action);
        ctx.out(`${PAST[action]} ${id}`);
      } catch (e) {
        const err = asAiBddError(e);
        ctx.err(`ai-bdd: ${id}: ${err ? `[${err.code}] ${err.message}` : e instanceof Error ? e.message : String(e)}`);
        const code = exitCodeForError(e);
        if (exit === 0 || code > exit) exit = code;
      }
    }
    return exit;
  });
}
