import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : path.endsWith('.js') ? [path] : [];
  });
}

for (const file of filesUnder(resolve('src'))) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
console.info(`Checked ${filesUnder(resolve('src')).length} server JavaScript files.`);
