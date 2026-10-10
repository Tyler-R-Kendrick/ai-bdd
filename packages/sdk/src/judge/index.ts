import { notImplemented, type CreateJudge, type ToJudgeEvidence } from '../contracts/index.ts';
export const JUDGE_PROMPT_VERSION = 'judge-v1';
export const createJudge: CreateJudge = () => notImplemented('judge.createJudge');
export const toJudgeEvidence: ToJudgeEvidence = () => notImplemented('judge.toJudgeEvidence');
