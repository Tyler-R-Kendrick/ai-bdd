/**
 * Generates app/model.json for the fake driver from the shared screen module.
 * Run: node fixtures/app/build-model.mjs
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initial, screens } from './screens.mjs';

export function buildModel() {
  return {
    version: 1,
    generatedFrom: 'fixtures/app/screens.mjs',
    initial,
    screens: screens.map((screen) => ({
      route: screen.route,
      title: screen.title,
      ...(screen.spinnerMs !== undefined ? { spinnerMs: screen.spinnerMs } : {}),
      nodes: screen.nodes.map((node) => ({
        role: node.role,
        name: node.name,
        ...(node.testId ? { testId: node.testId } : {}),
        ...(node.transition ? { transition: node.transition } : {}),
        ...(node.visibleWhen ? { visibleWhen: node.visibleWhen } : {}),
        ...(node.ancestors ? { ancestors: node.ancestors } : {}),
        ...(node.secret ? { secret: true } : {})
      })),
      dialogs: Object.fromEntries(
        Object.entries(screen.dialogs ?? {}).map(([key, nodes]) => [
          key,
          nodes.map((node) => ({ role: node.role, name: node.name, ...(node.testId ? { testId: node.testId } : {}), ...(node.transition ? { transition: node.transition } : {}) }))
        ])
      )
    }))
  };
}

const target = fileURLToPath(new URL('./model.json', import.meta.url));
if (process.argv[1] && process.argv[1].endsWith('build-model.mjs')) {
  writeFileSync(target, `${JSON.stringify(buildModel(), null, 2)}\n`);
  process.stdout.write(`wrote ${target}\n`);
}
