// A stand-in for the application under test: records how it was started (FAKE_APP_REPORT=<file>) and then idles until it is
// stopped. `--ignore-term` makes it ignore SIGTERM (appending a line to <report>.term for each one), so that only SIGKILL stops it.
import { appendFileSync, writeFileSync } from 'node:fs';

const report = process.env.FAKE_APP_REPORT;
const argv = process.argv.slice(2);
const ignoreTerm = argv.includes('--ignore-term');

if (report) writeFileSync(report, JSON.stringify({ pid: process.pid, argv, cwd: process.cwd(), env: process.env }));
process.on('SIGTERM', () => {
  if (report) appendFileSync(`${report}.term`, 'term\n');
  if (!ignoreTerm) process.exit(0);
});
setInterval(() => {}, 1000);
