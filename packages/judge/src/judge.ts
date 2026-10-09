import type {
  CalibrationLabel,
  CalibrationReport,
  ChatModel,
  JudgeConfig,
  JudgeRequest,
  JudgeSample,
  JudgeVerdict,
  JsonValue,
} from '@ai-bdd/contracts';
import { AiBddError, judgeCacheKey, sha256Hex } from '@ai-bdd/contracts';
import { JUDGE_PROMPT_VERSION, buildJudgePrompt } from './prompt.js';

export interface JudgeDependencies {
  model: ChatModel;
  config: JudgeConfig;
  /** Persists the request/response pair as evidence, when supplied. */
  writeEvidence?: (kind: 'judge-request' | 'judge-response', data: JsonValue) => Promise<void>;
  /** Reuse cache: judgeCacheKey -> verdict. */
  cache?: { get(key: string): JudgeVerdict | undefined; put(key: string, verdict: JudgeVerdict): void };
  /** Append-only calibration journal (R-K4a). */
  journal?: CalibrationJournal;
}

export interface Judge {
  judge(request: JudgeRequest): Promise<JudgeVerdict>;
}

/** One calibration record, appended to .ai-bdd/calibration/judgments.jsonl (R-K4a). */
export interface CalibrationJournal {
  append(record: {
    judgmentId: string;
    criterionHash: string;
    score: number;
    verdict: JudgeVerdict['verdict'];
    samples: number;
    model: string;
    evidenceIds?: string[];
  }): Promise<void>;
}

interface RawSample {
  probability: number;
  verdict: 'holds' | 'fails' | 'cannot_tell';
  explanation?: string;
  observed?: string;
}

/**
 * The scored judge (section 8.4, R-K3, R-K4, R-K19).
 *
 * `samples` independent judgments are taken at increasing temperature; each
 * sample's probability counts when its verdict agrees with it and is replaced by
 * 0.5 when it is contradictory or `cannot_tell`. The score is the mean, the
 * verdict comes from the pass/fail thresholds, and a spread above `maxSpread`
 * forces `inconclusive`.
 */
export function createJudge(deps: JudgeDependencies): Judge {
  const { model, config } = deps;

  return {
    async judge(request: JudgeRequest): Promise<JudgeVerdict> {
      const prompt = buildJudgePrompt(request);
      const key = judgeCacheKey({
        criterion: request.criterion,
        beforeShas: request.beforeImages.map((image) => image.ref ?? image.base64 ?? ''),
        afterShas: request.afterImages.map((image) => image.ref ?? image.base64 ?? ''),
        treeShas: [...request.beforeTrees, ...request.afterTrees],
        modelId: model.id,
        promptVersion: request.promptVersion ?? JUDGE_PROMPT_VERSION,
      });

      const cached = deps.cache?.get(key);
      if (cached) return { ...cached, reused: true };

      await deps.writeEvidence?.('judge-request', {
        criterion: request.criterion,
        actionPreceded: request.actionPreceded,
        beforeImages: request.beforeImages as unknown as JsonValue,
        afterImages: request.afterImages as unknown as JsonValue,
        system: prompt.system,
        user: prompt.user,
        modelId: model.id,
        promptVersion: JUDGE_PROMPT_VERSION,
      });

      const samples: JudgeSample[] = [];
      const count = Math.max(1, config.samples);
      for (let index = 0; index < count; index += 1) {
        const result = await model.generate({
          purpose: 'judge',
          temperature: 0.3 + index * 0.2,
          seed: 1000 + index,
          schema: { type: 'object' } as JsonValue,
          messages: [
            { role: 'system', content: prompt.system },
            {
              role: 'user',
              content: prompt.user,
              ...(config.vision && request.beforeImages.length + request.afterImages.length > 0
                ? { images: [...request.beforeImages, ...request.afterImages] }
                : {}),
            },
          ],
        });
        const raw = (result.object ?? safeJson(result.text)) as RawSample | undefined;
        if (!raw || typeof raw.probability !== 'number') {
          throw new AiBddError('MODEL_OUTPUT_INVALID', 'the judge returned no probability');
        }
        const probability = clamp01(raw.probability);
        const verdict = raw.verdict ?? 'cannot_tell';
        const agrees =
          (verdict === 'holds' && probability >= 0.5) || (verdict === 'fails' && probability < 0.5);
        const contradictory = verdict !== 'cannot_tell' && !agrees;
        samples.push({
          probability: verdict === 'cannot_tell' || contradictory ? 0.5 : probability,
          verdict,
          explanation: raw.explanation ?? '',
          observed: raw.observed ?? '',
          ...(contradictory ? { contradictory: true } : {}),
        });
      }

      const score = samples.reduce((sum, sample) => sum + sample.probability, 0) / samples.length;
      const probabilities = samples.map((sample) => sample.probability);
      const spread = Math.max(...probabilities) - Math.min(...probabilities);
      let verdictOutcome: JudgeVerdict['verdict'];
      let reason: string | undefined;
      if (spread > config.maxSpread) {
        verdictOutcome = 'inconclusive';
        reason = `the samples disagree (spread ${spread.toFixed(2)} > ${config.maxSpread})`;
      } else if (score >= config.passThreshold) {
        verdictOutcome = 'pass';
      } else if (score <= config.failThreshold) {
        verdictOutcome = 'fail';
      } else {
        verdictOutcome = 'inconclusive';
        reason = `the score ${score.toFixed(2)} is between the fail and pass thresholds`;
      }

      const verdict: JudgeVerdict = {
        score,
        verdict: verdictOutcome,
        samples,
        spread,
        modelId: model.id,
        promptVersion: request.promptVersion ?? JUDGE_PROMPT_VERSION,
        cacheKey: key,
        reused: false,
        ...(reason !== undefined ? { reason } : {}),
      };

      await deps.writeEvidence?.('judge-response', verdict as unknown as JsonValue);
      deps.cache?.put(key, verdict);
      await deps.journal?.append({
        judgmentId: key,
        criterionHash: sha256Hex(request.criterion),
        score: verdict.score,
        verdict: verdict.verdict,
        samples: verdict.samples.length,
        model: verdict.modelId,
        ...(verdict.evidenceIds !== undefined ? { evidenceIds: verdict.evidenceIds } : {}),
      });
      return verdict;
    },
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function safeJson(text: string | undefined): JsonValue | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}
