import { notImplemented, type DriverFactory, type DriverSession, type ObservedNode, type Policy, type SessionOptions } from '@ai-bdd/sdk/contracts';
export interface PlaywrightOptions { browser?: 'chromium' | 'firefox' | 'webkit'; headless?: boolean; launchOptions?: Record<string, unknown>; viewport?: { width: number; height: number }; recordVideo?: boolean }
export function playwright(_opts?: PlaywrightOptions): DriverFactory { return notImplemented('driver-playwright.playwright'); }
export function createDriverFactory(_options: Record<string, unknown>): DriverFactory { return notImplemented('driver-playwright.createDriverFactory'); }
export function sessionFromPage(_page: unknown, _sessionOpts: SessionOptions, _ctx: { policy: Policy; baseURL?: string }): Promise<DriverSession> { return notImplemented('driver-playwright.sessionFromPage'); }
export function parseAriaSnapshot(_text: string): ObservedNode[] { return notImplemented('driver-playwright.parseAriaSnapshot'); }
