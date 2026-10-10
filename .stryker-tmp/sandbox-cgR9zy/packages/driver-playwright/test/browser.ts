// @ts-nocheck
import { chromium } from 'playwright-core';
import type { Browser } from 'playwright-core';
import { discoverChromium } from '../src/index.ts';

/** Launch Chromium for raw-page tests, honoring AI_BDD_CHROMIUM_PATH and the preinstalled browser directory. */
export async function launchRaw(): Promise<Browser> {
  const explicit = process.env['AI_BDD_CHROMIUM_PATH'];
  try {
    return await chromium.launch(explicit ? { executablePath: explicit } : {});
  } catch (err) {
    const alt = discoverChromium(true);
    if (alt === undefined) throw err;
    return chromium.launch({ executablePath: alt });
  }
}

export async function browserAvailable(): Promise<boolean> {
  try {
    const b = await launchRaw();
    await b.close();
    return true;
  } catch {
    return false;
  }
}
