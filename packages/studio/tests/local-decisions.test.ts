import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { Auth } from '../server/auth.ts';
import { Store, hash } from '../server/store.ts';
import { openDatabase } from '../server/persistence/index.ts';
import { DecisionModels } from '../server/decisions/models.ts';
import { decisionSettingsFromEnv } from '../server/decisions/settings.ts';
import { registerDecisionRoutes } from '../server/decisions/routes.ts';
import { AgentProfiles } from '../server/integrations/agent-profiles.ts';
import {
  evaluateLocalDecisions,
  closeLocalModels,
} from '../server/local/model.ts';
import {
  DEFAULT_LOCAL_MODEL_ID,
  localModelFingerprint,
} from '../server/local/catalog.ts';
import {
  decisionProfileSchema,
  type DecisionQuestion,
} from '../shared/decision-profile.ts';
const directory = process.env.STUDIO_LOCAL_TEST_MODEL_DIR;
if (process.env.STUDIO_REQUIRE_LOCAL_MODEL_TEST === '1' && !directory)
  throw new Error(
    'STUDIO_LOCAL_TEST_MODEL_DIR is required for genuine CPU decision acceptance',
  );
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  await closeLocalModels();
});
const boolean = (instructions: string): DecisionQuestion => ({
  id: 'answer',
  kind: 'boolean',
  instructions,
});
const color: DecisionQuestion = {
  id: 'color',
  kind: 'choice',
  instructions: 'Which color is explicitly chosen?',
  choices: [{ value: 'red' }, { value: 'blue' }, { value: 'green' }],
};
const rubric: DecisionQuestion = {
  id: 'coverage',
  kind: 'score',
  instructions: 'Select the acceptance-test coverage level.',
  levels: [
    { label: 'No observable acceptance behavior' },
    { label: 'Observable behavior but no executable test' },
    { label: 'Observable behavior with an executable test' },
  ],
};
describe.skipIf(!directory)(
  'genuine offline CPU finite decisions (no provider transport)',
  () => {
    it('classifies balanced factual and human-approval predicates using the real chat wrapper and native token likelihoods', async () => {
      const rows = [];
      for (const [id, input, instructions, expected] of [
        [
          'blue',
          'The chosen color is blue.',
          'Does the document mention the color blue?',
          true,
        ],
        [
          'red',
          'The chosen color is red.',
          'Does the document mention the color blue?',
          false,
        ],
        [
          'unapproved',
          'The plan is still a draft. No human has approved it.',
          'Has a human approved this plan?',
          false,
        ],
        [
          'approved',
          'Alice reviewed the plan and explicitly approved it.',
          'Has a human approved this plan?',
          true,
        ],
      ] as const) {
        const result = await evaluateLocalDecisions(
          { directory: directory! },
          { input, questions: [boolean(instructions)] },
        );
        expect(result.answers[0]?.value, id).toBe(expected);
        expect(result.answers[0]?.probability).toBeGreaterThanOrEqual(0);
        expect(result.answers[0]?.probability).toBeLessThanOrEqual(1);
        expect(result).toMatchObject({
          probabilityKind: 'conditional-option-likelihood',
          calibrated: false,
        });
        expect(result.inputTokens).toBeGreaterThan(0);
        expect(result.rss).toBeLessThan(1024 ** 3);
        rows.push({
          id,
          probability: result.answers[0]?.probability,
          rss: result.rss,
        });
      }
      console.info('local-predicate-corpus', JSON.stringify(rows));
    });
    it('distinguishes finite color and work-intent choices without selecting a fixed option position', async () => {
      for (const [input, question, expected] of [
        ['The chosen color is blue.', color, 'blue'],
        ['The chosen color is red.', color, 'red'],
        [
          'I need to compare Postgres and SQLite transaction semantics.',
          {
            id: 'intent',
            kind: 'choice',
            instructions: 'What kind of work is requested?',
            choices: [
              { value: 'implementation' },
              { value: 'investigation' },
              { value: 'branding' },
            ],
          },
          'investigation',
        ],
        [
          'Implement the approved login button.',
          {
            id: 'intent',
            kind: 'choice',
            instructions: 'What kind of work is requested?',
            choices: [
              { value: 'implementation' },
              { value: 'investigation' },
              { value: 'branding' },
            ],
          },
          'implementation',
        ],
      ] as [string, DecisionQuestion, string][]) {
        const result = await evaluateLocalDecisions(
          { directory: directory! },
          { input, questions: [question] },
        );
        expect(result.answers[0]?.value).toBe(expected);
        expect(result.answers[0]?.confidence).toBeGreaterThan(0.7);
        expect(
          result.answers[0]?.probabilities?.reduce(
            (sum, p) => sum + p.probability,
            0,
          ),
        ).toBeCloseTo(1, 8);
        expect(result.rss).toBeLessThan(1024 ** 3);
      }
    });
    it('scores explicit release-risk rubric bins from real native likelihoods', async () => {
      const question: DecisionQuestion = {
        id: 'risk',
        kind: 'score',
        instructions: 'What risk level is explicitly stated?',
        levels: [{ label: 'Low' }, { label: 'Medium' }, { label: 'High' }],
      };
      for (const [input, expected] of [
        ['The recorded release risk is HIGH.', 2],
        ['The recorded release risk is LOW.', 0],
      ] as const) {
        const result = await evaluateLocalDecisions(
          { directory: directory! },
          { input, questions: [question] },
        );
        const answer = result.answers[0]!;
        console.info('local-risk-corpus', JSON.stringify({ input, answer }));
        const probabilities = answer.probabilities!;
        expect(probabilities[expected]!.probability).toBe(
          Math.max(...probabilities.map((item) => item.probability)),
        );
        expect(answer.value).toBeCloseTo(
          probabilities.reduce(
            (sum, item) => sum + Number(item.value) * item.probability,
            0,
          ),
          8,
        );
      }
    });
    for (const adapter of ['sqlite', 'postgres'] as const)
      describe.skipIf(
        adapter === 'postgres' && !process.env.STUDIO_TEST_POSTGRES_URL,
      )(
        adapter + ' real profiles, API and durable probability receipts',
        () => {
          async function fixture() {
            const store = await Store.open(
              adapter === 'sqlite'
                ? ':memory:'
                : await openDatabase({
                    adapter: 'postgres',
                    url: process.env.STUDIO_TEST_POSTGRES_URL!,
                    schema:
                      'local_decision_' + randomUUID().replaceAll('-', ''),
                  }),
            );
            cleanup.push(() => store.close());
            const user = await store.createUser(
                randomUUID() + '@test.invalid',
                'Local decision owner',
                null,
              ),
              project = await store.createProject(
                user,
                'Local decisions',
                '',
              ),
              artifact = await store.artifact(
                project.mainArtifactId,
                user.id,
              );
            const settings = decisionSettingsFromEnv({
                NODE_ENV: 'test',
                STUDIO_LOCAL_MODEL_DIR: directory,
                STUDIO_DECISION_TIMEOUT_MS: '45000',
              }),
              models = new DecisionModels({ store, settings });
            await models.ready;
            cleanup.push(() => models.close());
            const auth = new Auth(store, {
              production: false,
              origin: 'http://127.0.0.1:8787',
              dataDir: '/tmp',
              demo: false,
            });
            const app = Fastify();
            await app.register(cookie);
            app.setErrorHandler((error, _req, reply) =>
              reply
                .code((error as any).statusCode ?? 500)
                .send({ error: (error as Error).message }),
            );
            registerDecisionRoutes(app, { auth, models });
            cleanup.push(() => app.close());
            const token = 'local-decision-fixture-' + randomUUID();
            await store.exec(
              "INSERT INTO sessions(token,user_id,expires,kind) VALUES(?,?,?,'api')",
              hash(token),
              user.id,
              Date.now() + 60000,
            );
            const headers = { authorization: 'Bearer ' + token };
            return {
              store,
              user,
              project,
              artifact,
              models,
              settings,
              app,
              headers,
              request: async (
                input: string,
                questions: DecisionQuestion[] = [color],
              ) => ({
                user,
                artifactId: artifact.id,
                artifactVersion: artifact.version,
                profile: await models.captureProfile(user, artifact.id),
                input,
                questions,
                purpose: 'semantic-design-gap' as const,
                idempotencyKey: randomUUID(),
              }),
            };
          }
          it('persists an independent picker through authenticated API, records immutable local provenance, and caches without another admission', async () => {
            const f = await fixture(),
              chat = new AgentProfiles(
                f.store,
                { production: false } as any,
                {},
              );
            await chat.initialize();
            const prior = await chat.selected(f.artifact.id);
            const path =
              '/api/artifacts/' + f.artifact.id + '/decision/profile';
            const saved = await f.app.inject({
              method: 'PUT',
              url: path,
              headers: f.headers,
              payload: decisionProfileSchema.parse({
                provider: 'llama-cpp-cpu',
                model: DEFAULT_LOCAL_MODEL_ID,
                minimumConfidence: 0.7,
              }),
            });
            expect(saved.statusCode).toBe(200);
            expect(saved.json().independentOfChat).toBe(true);
            const loaded = await f.app.inject({
              url: path,
              headers: f.headers,
            });
            expect(loaded.json().profile).toEqual(saved.json().profile);
            expect(await chat.selected(f.artifact.id)).toEqual(prior);
            expect((await f.app.inject({ url: path })).statusCode).toBe(401);
            const request = await f.request('The chosen color is blue.');
            const result = await f.models.decide(request);
            expect(result.answers[0]).toMatchObject({
              status: 'answered',
              value: 'blue',
            });
            expect(result.provenance).toMatchObject({
              provider: 'llama-cpp-cpu',
              requestedModel: DEFAULT_LOCAL_MODEL_ID,
              modelResolution: 'pinned-local-weights',
              mode: 'native-decision',
              localInference: {
                calibrated: false,
                probabilityKind: 'conditional-option-likelihood',
                runtimeFingerprint: localModelFingerprint(),
                inputPreserved: true,
                contextTokens: 4096,
              },
            });
            expect(result.provenance.usage.inputTokens).toBeGreaterThan(0);
            expect(
              result.provenance.localInference!.sampledPeakRssBytes,
            ).toBeLessThan(1024 ** 3);
            expect(await f.models.decide(request)).toEqual(result);
            const cached = await f.models.decide({
              ...request,
              idempotencyKey: randomUUID(),
            });
            expect(cached.provenance.cachedFrom).toBe(result.id);
            expect(
              Number(
                (
                  await f.store.one(
                    'SELECT COUNT(*) AS n FROM studio_decision_admissions',
                  )
                )?.n,
              ),
            ).toBe(1);
            const history = await f.app.inject({
              url:
                '/api/artifacts/' + f.artifact.id + '/decision/evaluations',
              headers: f.headers,
            });
            expect(history.statusCode).toBe(200);
            expect(
              history.json().evaluations[0].provenance.localInference
                .calibrated,
            ).toBe(false);
            f.settings.configRevision = 'changed-runtime-registration';
            await expect(f.models.decide(request)).rejects.toMatchObject({
              statusCode: 409,
            });
          });
          it('retains uncertain ordinal-bin distributions as abstentions and rejects complete-input context overflow without truncation', async () => {
            const f = await fixture();
            const candidates: number[] = [];
            for (const [input, expected] of [
              [
                'When Save is clicked, a row named Draft appears. A browser test asserts the row text.',
                2,
              ],
              ['Make the application wonderful and easy.', 0],
            ] as const) {
              const result = await f.models.decide(
                  await f.request(input, [rubric]),
                ),
                answer = result.answers[0]!;
              expect(answer.status).toBe('abstained');
              expect(answer.value).toBeNull();
              expect(answer.candidate).toBeTypeOf('number');
              candidates.push(Number(answer.candidate));
              console.info(
                'local-rubric-corpus',
                JSON.stringify({
                  expectedMaximum: expected,
                  candidate: answer.candidate,
                  probabilities: answer.probabilities,
                }),
              );
              expect(answer.candidate).toBeCloseTo(
                answer.probabilities.reduce(
                  (sum, p) => sum + Number(p.value) * p.probability,
                  0,
                ),
                8,
              );
            }
            expect(candidates[0]).toBeGreaterThan(candidates[1]!);
            const overflow = await f.models.decide(
              await f.request('1234567890'.repeat(500), [
                boolean('Does this document contain any text?'),
              ]),
            );
            expect(overflow.answers[0]).toMatchObject({
              status: 'error',
              value: null,
              error: 'context-overflow',
            });
            expect(
              (
                await f.models.decide(
                  await f.request('The chosen color is red.'),
                )
              ).answers[0],
            ).toMatchObject({ status: 'answered', value: 'red' });
          });
        },
      );
  },
);
