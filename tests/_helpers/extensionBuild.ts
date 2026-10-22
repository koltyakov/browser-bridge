/** Browser-ready output produced by `make build-extension` before tests. */
export function extensionFile(relativePath: string): URL {
  return new URL(relativePath, new URL('../../dist/extension/', import.meta.url));
}

/** Load emitted code while keeping its source module's TypeScript contract. */
export async function loadExtensionModule<T>(relativePath: string): Promise<T> {
  return import(extensionFile(relativePath).href) as Promise<T>;
}
