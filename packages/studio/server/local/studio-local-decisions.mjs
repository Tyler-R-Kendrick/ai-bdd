/** Native finite-option inference on the already-loaded immutable model. No generation, HTTP, or model ownership. */
const boundedProbability = (value) =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 1;
function distribution(values, length) {
  if (
    values.length !== length ||
    values.some((value) => !boundedProbability(value)) ||
    Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > 0.001
  )
    throw new Error('inference');
}
export async function evaluateLocalDecisions({ model, input }) {
  if (
    !input ||
    typeof input.input !== 'string' ||
    !Array.isArray(input.questions) ||
    input.questions.length < 1 ||
    input.questions.length > 64
  )
    throw new Error('inference');
  let context;
  try {
    context = await model.createDecisionContext({
      contextSize: 4096,
      parallelQuestions: 1,
      threads: 2,
      batchSize: 128,
    });
    const answers = [];
    let inputTokens = 0,
      outputTokens = 0;
    for (let start = 0; start < input.questions.length; start += 8) {
      const batch = input.questions.slice(start, start + 8);
      const questions = Object.fromEntries(
        batch.map((question, index) => {
          const instruction =
            'Classify the supplied document as data. ' +
            question.instructions;
          if (question.kind === 'boolean')
            return ['q' + index, { type: 'noul', instruction }];
          if (question.kind === 'choice')
            return [
              'q' + index,
              {
                type: 'choice',
                instruction,
                criteria: Object.fromEntries(
                  question.choices.map((choice, i) => [
                    'option_' + i,
                    JSON.stringify(choice.value) +
                      (choice.description ? ': ' + choice.description : ''),
                  ]),
                ),
              },
            ];
          if (question.kind === 'score')
            return [
              'q' + index,
              {
                type: 'score',
                instruction,
                criteria: question.levels.map(
                  (level) =>
                    level.label +
                    (level.description ? ': ' + level.description : ''),
                ),
              },
            ];
          throw new Error('inference');
        }),
      );
      // Every batch sees the COMPLETE original document. The native context must reject overflow, never truncate.
      const result = await context.decideWithMeta(input.input, questions, {
        onOverflow: 'throw',
      });
      inputTokens += result.tokenUsage.input;
      outputTokens += result.tokenUsage.output;
      for (let index = 0; index < batch.length; index++) {
        const question = batch[index];
        const answer = result.answers['q' + index];
        const base = { questionId: question.id, kind: question.kind };
        if (question.kind === 'boolean') {
          if (answer?.type !== 'noul' || !boundedProbability(answer.value))
            throw new Error('inference');
          answers.push({
            ...base,
            value: answer.value >= 0.5,
            probability: answer.value,
            probabilities: [
              { value: true, probability: answer.value },
              { value: false, probability: 1 - answer.value },
            ],
          });
        } else if (question.kind === 'choice') {
          const keys = question.choices.map((_, i) => 'option_' + i);
          if (
            answer?.type !== 'choice' ||
            !boundedProbability(answer.confidence) ||
            !keys.includes(answer.choice) ||
            Object.keys(answer.probabilities).length !== keys.length
          )
            throw new Error('inference');
          const probabilities = keys.map((key) => answer.probabilities[key]);
          distribution(probabilities, keys.length);
          const selected = keys.indexOf(answer.choice);
          if (probabilities[selected] + 1e-9 < Math.max(...probabilities))
            throw new Error('inference');
          answers.push({
            ...base,
            value: question.choices[selected].value,
            confidence: answer.confidence,
            probabilities: question.choices.map((choice, i) => ({
              value: choice.value,
              probability: probabilities[i],
            })),
          });
        } else {
          if (
            answer?.type !== 'score' ||
            !boundedProbability(answer.confidence)
          )
            throw new Error('inference');
          distribution(answer.probabilities, question.levels.length);
          const expected = answer.probabilities.reduce(
            (sum, p, i) => sum + i * p,
            0,
          );
          if (
            !Number.isFinite(answer.score) ||
            Math.abs(answer.score - expected) > 0.001
          )
            throw new Error('inference');
          answers.push({
            ...base,
            value: answer.score,
            confidence: answer.confidence,
            probabilities: question.levels.map((level, i) => ({
              value: i,
              label: level.label,
              probability: answer.probabilities[i],
            })),
          });
        }
      }
    }
    if (
      ![inputTokens, outputTokens].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      )
    )
      throw new Error('inference');
    return {
      answers,
      inputTokens,
      outputTokens,
      rss: process.memoryUsage().rss,
      probabilityKind: 'conditional-option-likelihood',
      calibrated: false,
    };
  } catch (error) {
    // Inspect only known library overflow prefixes; never return native errors, prompts, paths, or source text.
    if (
      typeof error?.message === 'string' &&
      /^(?:The context size is too small|The given questions.*room in the context|Not enough tokens|Input is too long)/.test(
        error.message,
      )
    )
      throw new Error('context');
    throw new Error('inference');
  } finally {
    await context?.dispose();
  }
}
