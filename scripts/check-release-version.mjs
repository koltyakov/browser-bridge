import fs from 'node:fs';

const packageJson = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')
);
const extensionManifest = JSON.parse(
  fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')
);

const packageVersion = String(packageJson.version);
const extensionVersion = String(extensionManifest.version);
const packageLine = getVersionLine(packageVersion);
const extensionLine = getVersionLine(extensionVersion);

if (!packageLine || !extensionLine) {
  process.stderr.write(
    `Invalid release version: package.json is ${packageVersion}, manifest.json is ${extensionVersion}.\n`
  );
  process.exitCode = 1;
} else if (packageLine !== extensionLine) {
  process.stderr.write(
    `Release major/minor mismatch: package.json is ${packageVersion}, manifest.json is ${extensionVersion}.\n`
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Release version line matches (${packageLine}): package ${packageVersion}, extension ${extensionVersion}.\n`
  );
}

/**
 * npm and extension patch releases may advance independently, but both
 * artifacts must remain on the same major/minor compatibility line.
 *
 * @param {string} version
 * @returns {string | null}
 */
function getVersionLine(version) {
  const match = /^(\d+)\.(\d+)\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.exec(version);
  return match ? `${match[1]}.${match[2]}` : null;
}
