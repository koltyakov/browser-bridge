import { createDriver as createBBXDriver } from './bbx-driver.ts';

/** A real second configuration of BBX, not a stand-in for another product.
 * Useful for exercising paired reports and measuring input.perform composition. */
export function createDriver(options: { chrome: string; headed: boolean }) {
  return createBBXDriver({ ...options, sequence: true });
}
