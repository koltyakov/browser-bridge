/** Supply the browser manifest version when protocol helpers run in Node tests. */
export function setProtocolPackageVersion(version: string): void {
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    writable: true,
    value: { runtime: { getManifest: () => ({ version }) } },
  });
}
