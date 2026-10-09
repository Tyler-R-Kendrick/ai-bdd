/**
 * @ai-bdd/judge — the scored judge.
 *
 * The judge sees the criterion, the before/after evidence, the app vocabulary and
 * whether an action preceded the check. It has no channel for the act agent's
 * reasoning (R-K3a); `docs/adversarial-findings.md` records the canary test.
 */
export { createJudge, type CalibrationJournal, type Judge, type JudgeDependencies } from './judge.js';
export { JUDGE_PROMPT_VERSION, buildJudgePrompt } from './prompt.js';
export { calibrate, createCalibrationJournal } from './calibrate.js';
export { createJudgeCache, type JudgeCache } from './cache.js';
