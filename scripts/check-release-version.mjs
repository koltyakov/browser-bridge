// @ts-check
import { checkVersion } from './version.mjs';

try {
  const { version, source } = checkVersion();
  process.stdout.write(`Release version matches: ${version} (${source}).\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
