// @ts-check
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const app = 'dist/standalone/Browser Bridge.app';
const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
await fs.mkdir(`${app}/Contents/MacOS`, { recursive: true });
await fs.mkdir(`${app}/Contents/Resources`, { recursive: true });
for (const arch of ['arm64', 'x64'])
  await fs.copyFile(`dist/standalone/bbx-darwin-${arch}`, `${app}/Contents/Resources/bbx-${arch}`);
await fs.writeFile(
  `${app}/Contents/Info.plist`,
  `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>setup</string><key>CFBundleIdentifier</key><string>com.browserbridge.companion</string><key>CFBundleName</key><string>Browser Bridge</string><key>CFBundleVersion</key><string>${pkg.version}</string><key>CFBundleShortVersionString</key><string>${pkg.version}</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>`
);
await fs.writeFile(
  `${app}/Contents/MacOS/setup`,
  `#!/bin/sh
resources="$(CDPATH= cd -- "$(dirname -- "$0")/../Resources" && pwd)"
arch=$(uname -m)
[ "$arch" != x86_64 ] || arch=x64
if output=$("$resources/bbx-$arch" setup 2>&1); then
  /usr/bin/osascript "$resources/message.applescript" "Browser Bridge is ready. Return to the extension to connect your agent and enable window access. Restart existing terminals and agents once."
else
  /usr/bin/osascript "$resources/message.applescript" "Setup could not finish: $output"
  exit 1
fi
`,
  { mode: 0o755 }
);
await fs.writeFile(
  `${app}/Contents/Resources/message.applescript`,
  'on run argv\n display dialog (item 1 of argv) with title "Browser Bridge" buttons {"OK"} default button "OK"\nend run\n'
);
if (process.env.MACOS_SIGN_IDENTITY) {
  await fs.writeFile(
    'dist/standalone/entitlements.plist',
    '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/><key>com.apple.security.cs.disable-library-validation</key><true/></dict></plist>'
  );
  for (const arch of ['arm64', 'x64']) {
    execFileSync(
      'codesign',
      [
        '--force',
        '--options',
        'runtime',
        '--timestamp',
        '--entitlements',
        'dist/standalone/entitlements.plist',
        '--sign',
        process.env.MACOS_SIGN_IDENTITY,
        `${app}/Contents/Resources/bbx-${arch}`,
      ],
      { stdio: 'inherit' }
    );
    // Sign the raw executable assets too; update hashes are generated afterward.
    await fs.copyFile(
      `${app}/Contents/Resources/bbx-${arch}`,
      `dist/standalone/bbx-darwin-${arch}`
    );
  }
  execFileSync(
    'codesign',
    [
      '--force',
      '--options',
      'runtime',
      '--timestamp',
      '--sign',
      process.env.MACOS_SIGN_IDENTITY,
      app,
    ],
    { stdio: 'inherit' }
  );
}
const zip = 'dist/standalone/Browser-Bridge-macOS.zip';
execFileSync('ditto', ['-c', '-k', '--keepParent', app, zip], { stdio: 'inherit' });
if (process.env.MACOS_NOTARY_PROFILE) {
  execFileSync(
    'xcrun',
    ['notarytool', 'submit', zip, '--keychain-profile', process.env.MACOS_NOTARY_PROFILE, '--wait'],
    { stdio: 'inherit' }
  );
  execFileSync('xcrun', ['stapler', 'staple', app], { stdio: 'inherit' });
  await fs.rm(zip);
  execFileSync('ditto', ['-c', '-k', '--keepParent', app, zip], { stdio: 'inherit' });
}
