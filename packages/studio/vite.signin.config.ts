import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import base from './vite.config.ts';

// Linked workspace dependencies may live outside an isolated review worktree.
// Keep this allowance in the UI test server; deployment uses vite.config.ts.
export default mergeConfig(base, {
  server: {
    fs: {
      allow: [
        fileURLToPath(new URL('../..', import.meta.url)),
        realpathSync(fileURLToPath(new URL('./node_modules', import.meta.url))),
        realpathSync(fileURLToPath(new URL('../../node_modules', import.meta.url))),
      ],
    },
  },
});
