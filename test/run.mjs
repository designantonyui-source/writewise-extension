// Runs every unit suite in this folder and exits non-zero on the first failure.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const suites = readdirSync(here).filter((f) => f.endsWith('.test.mjs')).sort();

let failed = 0;
for (const suite of suites) {
  console.log(`\n=== ${suite} ===`);
  const run = spawnSync(process.execPath, [join(here, suite)], { stdio: 'inherit' });
  if (run.status !== 0) failed += 1;
}

console.log(`\n${failed ? `${failed} suite(s) failed` : `all ${suites.length} suites passed`}`);
process.exit(failed ? 1 : 0);
