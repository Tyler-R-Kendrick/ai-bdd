import { afterEach, describe, expect, it } from 'vitest';
import { generateText, streamText, Output, tool } from 'ai';
import { z } from 'zod';
import { mkdtemp, rm, truncate, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLocalLanguageModel,
  closeLocalModels,
} from '../server/local/model.ts';
import {
  localModelManifest,
  LOCAL_MODEL_ID,
  localModelPresent,
} from '../server/local/catalog.ts';
const cleanup: string[] = [];
afterEach(async () => {
  await closeLocalModels();
  for (const path of cleanup.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function temporary() {
  const path = await mkdtemp(join(tmpdir(), 'studio-local-model-'));
  cleanup.push(path);
  return path;
}
it('requires a trusted absolute directory and refuses absent assets without a network fallback', async () => {
  expect(() => createLocalLanguageModel({ directory: 'relative' })).toThrow(
    'absolute',
  );
  const directory = await temporary();
  expect(localModelPresent({ directory })).toBe(false);
  await expect(
    generateText({
      model: createLocalLanguageModel({ directory }),
      prompt: 'Hello',
      maxRetries: 0,
    }),
  ).rejects.toMatchObject({ code: 'inference' });
});
it('rejects same-size altered model bytes and symlinks before inference', async () => {
  const directory = await temporary(),
    path = join(directory, localModelManifest.files[0]!.path);
  await writeFile(path, '');
  await truncate(path, localModelManifest.files[0]!.bytes);
  expect(localModelPresent({ directory })).toBe(true);
  await expect(
    generateText({
      model: createLocalLanguageModel({ directory }),
      prompt: 'Hello',
      maxRetries: 0,
    }),
  ).rejects.toMatchObject({ code: 'assets' });
  await closeLocalModels();
  await rm(path);
  await symlink(join(directory, 'missing'), path);
  expect(localModelPresent({ directory })).toBe(false);
  await expect(
    generateText({
      model: createLocalLanguageModel({ directory }),
      prompt: 'Hello',
      maxRetries: 0,
    }),
  ).rejects.toMatchObject({ code: 'assets' });
});
const directory = process.env.STUDIO_LOCAL_TEST_MODEL_DIR;
if (process.env.STUDIO_REQUIRE_LOCAL_MODEL_TEST === '1' && !directory)
  throw new Error(
    'STUDIO_LOCAL_TEST_MODEL_DIR is required for real local inference acceptance',
  );
describe.skipIf(!directory)(
  'actual pinned CPU model, with all inference HTTP disabled inside its worker',
  () => {
    it('runs genuine deterministic chat and native schema-constrained JSON generation', async () => {
      const model = createLocalLanguageModel({ directory: directory! });
      const options = {
        model,
        system: 'You are a helpful assistant. Answer briefly.',
        prompt: 'What is 2 + 2?',
        maxOutputTokens: 64,
        maxRetries: 0,
      };
      const first = await generateText(options),
        second = await generateText(options);
      expect(first.text).toContain('4');
      expect(second.text).toBe(first.text);
      expect(first.usage.inputTokens).toBeGreaterThan(0);
      expect(first.usage.outputTokens).toBeGreaterThan(0);
      expect(first.response.modelId).toBe(LOCAL_MODEL_ID);
      const structured = await generateText({
        ...options,
        prompt: 'What is 2 + 2? Return JSON with integer answer.',
        output: Output.object({
          schema: z.object({ answer: z.number().int() }).strict(),
        }),
      });
      expect(structured.output).toEqual({ answer: 4 });
      expect(structured.providerMetadata?.['llama-cpp-cpu']?.constrained).toBe(
        true,
      );
    });
    it('constrains advertised tool name/arguments and executes only the server-defined tool', async () => {
      let calls = 0;
      const result = await generateText({
        model: createLocalLanguageModel({ directory: directory! }),
        prompt: 'Select the blue color using choose_color.',
        tools: {
          choose_color: tool({
            description: 'Select the requested color',
            inputSchema: z
              .object({ color: z.enum(['blue', 'green']) })
              .strict(),
            execute: async (input) => {
              calls++;
              return { selected: input.color };
            },
          }),
        },
        toolChoice: { type: 'tool', toolName: 'choose_color' },
        maxOutputTokens: 80,
        maxRetries: 0,
      });
      expect(calls).toBe(1);
      expect(result.toolCalls[0]?.toolName).toBe('choose_color');
      expect(result.toolCalls[0]?.input).toEqual({ color: 'blue' });
      expect(result.finishReason).toBe('tool-calls');
    });
    it('streams actual generated text, refuses oversized source, and terminates aborted inference without poisoning the next request', async () => {
      const model = createLocalLanguageModel({ directory: directory! });
      const stream = streamText({
        model,
        system: 'You are a helpful assistant. Answer briefly.',
        prompt: 'What is 2 + 2?',
        maxOutputTokens: 64,
        maxRetries: 0,
      });
      let text = '',
        chunks = 0;
      for await (const chunk of stream.textStream) {
        text += chunk;
        chunks++;
      }
      expect(text).toContain('4');
      expect(chunks).toBeGreaterThan(1);
      await expect(
        generateText({
          model,
          prompt: 'Large source '.repeat(5000),
          maxRetries: 0,
        }),
      ).rejects.toMatchObject({ code: 'context', statusCode: 413 });
      const abort = new AbortController();
      const pending = generateText({
        model,
        prompt: 'Count all whole numbers from 1 to 1000.',
        maxOutputTokens: 1024,
        maxRetries: 0,
        abortSignal: abort.signal,
      });
      setTimeout(
        () =>
          abort.abort(
            new DOMException('Acceptance cancellation', 'AbortError'),
          ),
        10,
      );
      await expect(pending).rejects.toThrow();
      expect(
        (
          await generateText({
            model,
            system: 'You are a helpful assistant. Answer briefly.',
            prompt: 'What is 2 + 2?',
            maxOutputTokens: 64,
            maxRetries: 0,
          })
        ).text,
      ).toContain('4');
    });
  },
);
