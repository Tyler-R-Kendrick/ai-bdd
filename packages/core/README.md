# @ai-bdd/core

The facade re-exported for application code.

```ts
import { defineConfig, bind, Given, When, Then, defineParameterType } from '@ai-bdd/core';
import { playwright } from '@ai-bdd/driver-playwright';
import { cua } from '@ai-bdd/driver-cua';
import { e2e } from '@ai-bdd/driver-e2e';
import { aiSdkModels } from '@ai-bdd/models';
import { gateway } from 'ai';

export default defineConfig({
  specs: ['specs/**/*.spec.md', 'features/**/*.feature'],
  drivers: {
    web: playwright({ browser: 'chromium', baseURL: 'http://localhost:3000' }),
    mobile: e2e({ config: './e2e.config.ts', target: 'ios' }),
    desktop: cua({ app: 'com.example.Billing' }),
  },
  models: aiSdkModels({ act: gateway('openai/gpt-5-mini'), judge: gateway('anthropic/claude-sonnet-4.5'), embed: gateway.textEmbeddingModel('openai/text-embedding-3-small') }),
});
```

`defineConfig` is an identity function: it exists so the config file is typed and so an
unknown key is a compile-time error as well as a runtime `CONFIG_UNKNOWN_KEY`.

The binding helpers register into the registry the runtime consults first, so existing step
code keeps winning over the agent:

```ts
import { bind } from '@ai-bdd/core';

bind({
  pattern: 'Seed a workspace {string} on the {string} plan',
  description: 'Seeds a workspace with a name and a plan tier',
  kind: 'setup',
  examples: ['Seed a workspace "Acme" on the "free" plan'],
  counterExamples: ['Seed an empty workspace'],
  params: [{ name: 'name', type: 'string' }, { name: 'plan', type: 'enum', enumValues: ['free', 'pro'] }],
  fn: (params) => seedWorkspace(params),
});
```
