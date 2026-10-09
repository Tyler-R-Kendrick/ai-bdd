import type { CalibrationBin, CalibrationLabel, CalibrationReport } from '@ai-bdd/contracts';

/** Expected calibration error over 10 bins, Brier score and recommended thresholds (R-K4b). */
export function calibrate(
  judgments: Array<{ judgmentId: string; score: number }>,
  labels: CalibrationLabel[],
  options: { bins?: number } = {},
): CalibrationReport {
  const truth = new Map(labels.map((label) => [label.judgmentId, label.truth]));
  const pairs = judgments
    .filter((judgment) => truth.has(judgment.judgmentId))
    .map((judgment) => ({ score: judgment.score, truth: truth.get(judgment.judgmentId)! }));

  const binCount = options.bins ?? 10;
  const bins: CalibrationBin[] = [];
  for (let index = 0; index < binCount; index += 1) {
    const lower = index / binCount;
    const upper = (index + 1) / binCount;
    const members = pairs.filter(
      (pair) => pair.score >= lower && (index === binCount - 1 ? pair.score <= upper : pair.score < upper),
    );
    const positives = members.filter((member) => member.truth).length;
    const meanScore = members.length > 0 ? members.reduce((sum, member) => sum + member.score, 0) / members.length : 0;
    bins.push({
      lower,
      upper,
      count: members.length,
      positives,
      meanScore,
      accuracy: members.length > 0 ? positives / members.length : 0,
    });
  }

  const total = pairs.length;
  const ece =
    total === 0 ? 0 : bins.reduce((sum, bin) => sum + (bin.count / total) * Math.abs(bin.accuracy - bin.meanScore), 0);
  const brier =
    total === 0 ? 0 : pairs.reduce((sum, pair) => sum + (pair.score - (pair.truth ? 1 : 0)) ** 2, 0) / total;

  return {
    count: total,
    ece,
    brier,
    bins,
    recommended: {
      passThreshold: recommendThreshold(pairs, 0.5, 1),
      failThreshold: recommendThreshold(pairs, 0.5, -1),
    },
  };
}

/**
 * Picks the threshold that maximises label accuracy, searched over the observed
 * scores. `direction` 1 looks for the pass threshold (above => positive) and -1
 * for the fail threshold (below => negative).
 */
function recommendThreshold(pairs: Array<{ score: number; truth: boolean }>, fallback: number, direction: 1 | -1): number {
  if (pairs.length === 0) return fallback;
  const candidates = [...new Set(pairs.map((pair) => pair.score))].sort((a, b) => a - b);
  let best = fallback;
  let bestAccuracy = -1;
  for (const candidate of candidates) {
    const correct = pairs.filter((pair) =>
      direction === 1 ? (pair.score >= candidate) === pair.truth : (pair.score <= candidate) === !pair.truth,
    ).length;
    const accuracy = correct / pairs.length;
    if (accuracy > bestAccuracy) {
      bestAccuracy = accuracy;
      best = Number(candidate.toFixed(2));
    }
  }
  return best;
}

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CalibrationJournal } from './judge.js';

/**
 * Appends every judgment to `.ai-bdd/calibration/judgments.jsonl` (R-K4a) so that
 * `ai-bdd calibrate --labels` has real data to work with. The file is JSONL, one
 * record per line, and is safe to append from concurrent workers.
 */
export function createCalibrationJournal(path: string): CalibrationJournal {
  return {
    async append(record): Promise<void> {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify({ ...record, at: new Date().toISOString() })}\n`);
    },
  };
}
