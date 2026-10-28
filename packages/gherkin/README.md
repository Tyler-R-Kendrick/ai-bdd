# @ai-bdd/gherkin

Formal Gherkin input for ai-bdd, using the official Cucumber parser and AST.

```js
import { defineConfig } from '@ai-bdd/sdk';
import { gherkin } from '@ai-bdd/gherkin';

export default defineConfig({
  docs: ['docs/**/*.feature'],
  extensions: [gherkin()],
});
```

`gherkin()` returns the core `DocumentExtension`: `.feature` files use Cucumber's parser and Pickle compiler, produce grounded ai-bdd plans without an extraction model, and then run through the ordinary recordings, agents, judges, drivers, reports and evidence gates. Background steps, Rules, tags, dialects and Scenario Outline expansion are supported.

Tags on the Feature also select verification policy, for example `@web @risk:high @formal` or `@cli @evidence:log,test-report`.

For tooling, `parseGherkin(text, uri?, { defaultDialect? })` returns the official `{ ast, pickles }`. The full guide is [docs/gherkin.md](../../docs/gherkin.md).
