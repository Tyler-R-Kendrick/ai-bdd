import { notImplemented, type DriverFactory } from '@ai-bdd/sdk/contracts';
export function fakeDriver(_opts?: { flags?: string[]; adminPassword?: string; clockStepMs?: number; maxSessions?: number; exclusiveResource?: string }): DriverFactory {
  return notImplemented('testing.fakeDriver');
}
