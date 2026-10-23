// @ts-check
// Code generated from protocol/install-targets.json. DO NOT EDIT.
/** @typedef {{key: string, goos: string, goarch: string, asset: string, runner: string, unixPatterns?: string[], windowsArch?: string}} NativePlatform */
/** @type {readonly NativePlatform[]} */
export const nativePlatforms = Object.freeze([
  {
    key: 'darwin-arm64',
    goos: 'darwin',
    goarch: 'arm64',
    asset: 'bbx-darwin-arm64',
    runner: 'macos-15',
    unixPatterns: ['Darwin:arm64', 'Darwin:aarch64'],
  },
  {
    key: 'darwin-x64',
    goos: 'darwin',
    goarch: 'amd64',
    asset: 'bbx-darwin-x64',
    runner: 'macos-15-intel',
    unixPatterns: ['Darwin:x86_64', 'Darwin:amd64'],
  },
  {
    key: 'linux-arm64',
    goos: 'linux',
    goarch: 'arm64',
    asset: 'bbx-linux-arm64',
    runner: 'ubuntu-24.04-arm',
    unixPatterns: ['Linux:arm64', 'Linux:aarch64'],
  },
  {
    key: 'linux-x64',
    goos: 'linux',
    goarch: 'amd64',
    asset: 'bbx-linux-x64',
    runner: 'ubuntu-24.04',
    unixPatterns: ['Linux:x86_64', 'Linux:amd64'],
  },
  {
    key: 'win32-x64',
    goos: 'windows',
    goarch: 'amd64',
    asset: 'bbx-windows-x64.exe',
    runner: 'windows-2025',
    windowsArch: 'AMD64',
  },
]);
/** @type {Readonly<Record<string, string>>} */
export const nativeTargets = Object.freeze({
  'darwin-arm64': 'bbx-darwin-arm64',
  'darwin-x64': 'bbx-darwin-x64',
  'linux-arm64': 'bbx-linux-arm64',
  'linux-x64': 'bbx-linux-x64',
  'win32-x64': 'bbx-windows-x64.exe',
});
export const nativeMaxBytes = 10000000;
