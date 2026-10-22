/** Packaging replaces this with the staged extension's SHA-256 digest.
Unpackaged checkouts report null rather than a stale release ID. */
export const SOURCE_DIGEST: string | null = null;

/** Enabled only by the unpacked development build, never release packaging. */
export const DEVELOPMENT_AUTO_RELOAD: boolean = false;
