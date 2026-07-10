import fs from 'node:fs';

const packageJson = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')
);
const extensionManifest = JSON.parse(
  fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')
);

if (packageJson.version !== extensionManifest.version) {
  process.stderr.write(
    `Release version mismatch: package.json is ${String(packageJson.version)}, manifest.json is ${String(extensionManifest.version)}.\n`
  );
  process.exitCode = 1;
} else {
  process.stdout.write(`Release versions match: ${String(packageJson.version)}.\n`);
}
