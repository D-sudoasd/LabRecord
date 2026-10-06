import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const executable = resolve('release/win-unpacked/LabRecord.exe');
if (process.platform !== 'win32' || !existsSync(executable))
  throw new Error('Run npm run package on Windows first.');
const result = spawnSync(
  process.execPath,
  [
    fileURLToPath(new URL('../node_modules/@playwright/test/cli.js', import.meta.url)),
    'test',
    '--reporter=list,json',
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      LABRECORD_EXECUTABLE: executable,
      PLAYWRIGHT_JSON_OUTPUT_FILE: resolve('test-results/desktop-report.json'),
    },
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
