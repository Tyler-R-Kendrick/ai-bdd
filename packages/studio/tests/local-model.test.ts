import { afterEach, describe, expect, it } from 'vitest';
import { generateText, streamText, Output, tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { mkdtemp, rm, truncate, writeFile, symlink } from 'node:fs/promises';
import { execFile, fork } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLocalLanguageModel,
  closeLocalModels,
  retainLocalModel,
  evaluateLocalDecisions,
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
it('rejects unsupported schema formats before starting inference', async () => {
  const model = createLocalLanguageModel({
    directory: '/nonexistent-operator-model',
  });
  await expect(
    model.doGenerate({
      prompt: [
        { role: 'user', content: [{ type: 'text', text: 'Return a string.' }] },
      ],
      responseFormat: {
        type: 'json',
        schema: { type: 'string', format: 'studio-unsupported-format' },
      },
    }),
  ).rejects.toMatchObject({ code: 'schema', statusCode: 400 });
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
    it('independently refuses generated invalid email/date values under original schemas', async () => {
      const model = createLocalLanguageModel({ directory: directory! });
      for (const [format, value] of [
        ['email', 'not-an-email'],
        ['date', '2026-99-99'],
      ]) {
        await expect(
          model.doGenerate({
            prompt: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: 'Return the required JSON string.' },
                ],
              },
            ],
            responseFormat: {
              type: 'json',
              schema: { type: 'string', const: value, format },
            },
            maxOutputTokens: 64,
          }),
        ).rejects.toMatchObject({ code: 'schema' });
      }
    });
    it('bounds concurrent work and keeps each generated receipt with its caller', async () => {
      const model = createLocalLanguageModel({ directory: directory! });
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, (_, index) =>
          model.doGenerate({
            prompt: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: 'Return the required JSON string.' },
                ],
              },
            ],
            responseFormat: {
              type: 'json',
              schema: { type: 'string', const: 'receipt-' + index },
            },
            maxOutputTokens: 32,
          }),
        ),
      );
      const accepted = results.filter(
        (result) => result.status === 'fulfilled',
      );
      expect(accepted).toHaveLength(4);
      results.forEach((result, index) => {
        if (result.status === 'fulfilled')
          expect(result.value.content).toEqual([
            { type: 'text', text: JSON.stringify('receipt-' + index) },
          ]);
        else
          expect(result.reason).toMatchObject({
            code: 'busy',
            statusCode: 429,
          });
      });
    });
    it('releases only the last directory owner and closes idle subprocesses with exit code zero', async () => {
      const first = retainLocalModel(directory!),
        second = retainLocalModel(directory!);
      const model = createLocalLanguageModel({ directory: directory! });
      const pending = generateText({
        model,
        system: 'You are a helpful assistant. Answer briefly.',
        prompt: 'What is 2 + 2?',
        maxOutputTokens: 64,
        maxRetries: 0,
      });
      await first();
      expect((await pending).text).toContain('4');
      await first();
      await second();
      await expect(
        generateText({ model, prompt: 'Hello', maxRetries: 0 }),
      ).rejects.toMatchObject({ code: 'configuration' });
      const source = new URL('../server/local/model.ts', import.meta.url).href;
      const script = `import {createLocalLanguageModel,closeLocalModels} from ${JSON.stringify(source)};const model=createLocalLanguageModel({directory:${JSON.stringify(directory)}});await model.doGenerate({prompt:[{role:'user',content:[{type:'text',text:'What is 2 + 2?'}]}],maxOutputTokens:32});await closeLocalModels();console.log('closed');`;
      const result = await promisify(execFile)(
        process.execPath,
        [
          '--import',
          import.meta.resolve('tsx'),
          '--input-type=module',
          '--eval',
          script,
        ],
        {
          timeout: 15000,
          maxBuffer: 10000,
          env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
        },
      );
      expect(result.stdout.trim()).toBe('closed');
    });
    it('stops a real inference subprocess when its private RSS ceiling is exceeded', async () => {
      const child = fork(
        new URL('../server/local/studio-local-worker.mjs', import.meta.url),
        [],
        {
          execArgv: [],
          env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        },
      );
      const exited = once(child, 'exit');
      try {
        const message = once(child, 'message');
        child.send({
          modelId: localModelManifest.id,
          configuration: {
            directory: directory!,
            file: localModelManifest.files[0],
            rssCeilingBytes: 16777216,
          },
          system: '',
          prompt: 'Hello',
          history: [],
          maxTokens: 16,
        });
        expect((await message)[0]).toMatchObject({ type: 'error', code: 'memory', rssCeilingBytes: 16777216 });
        expect((await exited)[0]).toBe(1);
      } finally {
        child.kill('SIGKILL');
      }
    });
    it('uses the same pool for actual native decision logits and following chat', async () => {
      const result = await evaluateLocalDecisions(
        { directory: directory! },
        {
          input: 'The chosen color is blue.',
          questions: [
            {
              id: 'blue',
              kind: 'boolean',
              instructions: 'Does the document mention the color blue?',
            },
          ],
        },
      );
      expect(result.probabilityKind).toBe('conditional-option-likelihood');
      expect(result.calibrated).toBe(false);
      expect(typeof result.answers[0]?.value).toBe('boolean');
      expect(result.answers[0]?.probability).toBeGreaterThanOrEqual(0);
      expect(result.answers[0]?.probability).toBeLessThanOrEqual(1);
      expect(result.inputTokens).toBeGreaterThan(0);
      const response = await generateText({
        model: createLocalLanguageModel({ directory: directory! }),
        system: 'You are a helpful assistant. Answer briefly.',
        prompt: 'What is 2 + 2?',
        maxOutputTokens: 64,
        maxRetries: 0,
      });
      expect(response.text).toContain('4');
    });
    it('continues a real tool loop using its returned result and prior chat history', async () => {
      let calls = 0;
      const result = await generateText({
        model: createLocalLanguageModel({ directory: directory! }),
        system:
          'You are a helpful assistant. Answer briefly. Use the returned tool result.',
        messages: [
          {
            role: 'user',
            content:
              'The release number is unknown. Read it with release_number, then state the number returned by the tool.',
          },
        ],
        tools: {
          release_number: tool({
            description: 'Read the current release number.',
            inputSchema: z.object({}).strict(),
            execute: async () => {
              calls++;
              return { releaseNumber: 42 };
            },
          }),
        },
        prepareStep: ({ stepNumber }) => ({
          toolChoice:
            stepNumber === 0
              ? { type: 'tool', toolName: 'release_number' }
              : 'none',
        }),
        stopWhen: stepCountIs(2),
        maxOutputTokens: 128,
        maxRetries: 0,
      });
      expect(calls).toBe(1);
      expect(result.steps).toHaveLength(2);
      expect(result.text).toContain('42');
      const history = await generateText({
        model: createLocalLanguageModel({ directory: directory! }),
        system: 'You are a helpful assistant. Answer briefly.',
        messages: [
          { role: 'user', content: 'My chosen color is blue.' },
          { role: 'assistant', content: 'Your chosen color is blue.' },
          { role: 'user', content: 'What color did I choose?' },
        ],
        maxOutputTokens: 64,
        maxRetries: 0,
      });
      expect(history.text.toLowerCase()).toContain('blue');
    });
    it('streams actual generated text, refuses oversized source, and terminates aborted inference without poisoning the next request', async () => {
      const model = createLocalLanguageModel({ directory: directory! });
      const stream = streamText({
        model,
        system: 'You are a helpful assistant. Answer briefly.',
        prompt:
          'Design requirement: The home page must show a blue button labelled Start. Explain what the UI developer should build in one sentence.',
        maxOutputTokens: 96,
        maxRetries: 0,
      });
      let text = '',
        chunks = 0;
      for await (const chunk of stream.textStream) {
        text += chunk;
        chunks++;
      }
      expect(text.toLowerCase()).toContain('blue');
      expect(text).toContain('Start');
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
