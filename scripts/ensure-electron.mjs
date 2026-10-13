// Electron 44 no longer downloads its binary from an install hook, and pnpm blocks dependency scripts by default.
// This fetches the binary once after `pnpm install`, unless ELECTRON_SKIP_BINARY_DOWNLOAD is set (e.g. in CI).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) process.exit(0);
const require = createRequire(new URL('../packages/shell/package.json', import.meta.url));
let dir;
try {
  dir = dirname(require.resolve('electron/package.json'));
} catch {
  process.exit(0); // shell dependencies not installed yet
}
if (existsSync(join(dir, 'path.txt'))) process.exit(0);
console.log('Downloading the Electron binary...');
const result = spawnSync(process.execPath, [join(dir, 'install.js')], { stdio: 'inherit', cwd: dir });
process.exit(result.status ?? 1);
