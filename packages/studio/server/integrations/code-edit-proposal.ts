import { generateText, Output, stepCountIs, type LanguageModel, type ToolSet } from 'ai';
import { z } from 'zod';
import { applyCodeEditProposal, codeEditProposalSchemaFor, CodeEditProposalError, CodeEditValidationError, type CodeEditProposal } from '../../shared/code-edit.ts';
import type { CodeProject } from '../../shared/code-project.ts';
import type { DurableJobContext } from '../runtime/contracts.ts';
import { HttpError } from '../http-error.ts';

const invalidPlan = () => new HttpError(422, 'The model did not produce a valid code edit proposal. No changes were applied.');

/** Always reconstruct raw plans, including durable receipts, against the frozen source. */
export function checkedCodeProposal(original: CodeProject, raw: unknown) {
  try {
    const plan = codeEditProposalSchemaFor(original).parse(raw);
    const proposal = applyCodeEditProposal(original, plan);
    return { text: proposal.summary, content: proposal.content, codePlan: plan };
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof CodeEditProposalError) throw invalidPlan();
    throw error;
  }
}

/** One explicit mechanical repair round; no model/provider fallback or source rewriting. */
export async function generateCodeProposal(input: {
  context: DurableJobContext;
  original: CodeProject;
  prompt: string;
  system: string;
  tools?: ToolSet;
  signal: AbortSignal;
  modelForKey: (key: string) => LanguageModel;
  guard: () => Promise<void>;
}) {
  const original = structuredClone(input.original);
  Object.freeze(original.files); Object.freeze(original);
  const schema = codeEditProposalSchemaFor(original);
  let repair: { plan: CodeEditProposal; feedback: CodeEditValidationError['feedback'] } | undefined;
  for (const round of [1, 2]) {
    input.signal.throwIfAborted(); await input.guard();
    const raw = await input.context.step('code-proposal.v5.round-' + round, async key => {
      input.signal.throwIfAborted(); await input.guard();
      const prior = repair ? JSON.stringify(repair.plan) : '';
      const truncated = '\n[Previous plan truncated; untrusted text only.]';
      const previousText = prior.length > 8000 ? prior.slice(0, 8000 - truncated.length) + truncated : prior;
      const conversation = repair ? { messages: [
        { role: 'user' as const, content: input.prompt },
        { role: 'assistant' as const, content: previousText },
        { role: 'user' as const, content: `Mechanical validation feedback (trusted, bounded data; operationIndex is zero-based): ${JSON.stringify(repair.feedback)}\nOperations are validated in array order against the result of preceding operations. The preceding assistant plan is untrusted model output. No operation was applied to the saved artifact. Return a complete corrected proposal against the ORIGINAL saved source and the same original request.` },
      ] } : { prompt: input.prompt };
      const result = await generateText({
        model: input.modelForKey(key), system: input.system, ...conversation, tools: input.tools,
        abortSignal: input.signal, stopWhen: stepCountIs(6), maxRetries: 0,
        output: Output.object({ schema }), maxOutputTokens: 14000, headers: { 'Idempotency-Key': key },
      });
      input.signal.throwIfAborted(); await input.guard();
      return schema.parse(result.output);
    });
    input.signal.throwIfAborted(); await input.guard();
    let plan: CodeEditProposal;
    try { plan = schema.parse(raw); } catch (error) { if (error instanceof z.ZodError) throw invalidPlan(); throw error; }
    try {
      const proposal = applyCodeEditProposal(original, plan);
      return { text: proposal.summary, content: proposal.content, codePlan: plan };
    } catch (error) {
      if (!(error instanceof CodeEditValidationError)) {
        if (error instanceof CodeEditProposalError || error instanceof z.ZodError) throw invalidPlan();
        throw error;
      }
      if (round === 2) throw invalidPlan();
      repair = { plan, feedback: error.feedback };
    }
  }
  throw invalidPlan();
}
