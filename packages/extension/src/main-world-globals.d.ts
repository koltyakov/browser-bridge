/**
 * Type declarations for Browser Bridge globals injected into page main worlds
 * via chrome.scripting.executeScript. These properties exist only on pages
 * where BBX interceptors have been installed.
 *
 * @module main-world-globals
 */

export {};

/**
 * @typedef {object} NetworkEntry
 * @property {string} method
 * @property {string} url
 * @property {number} status
 * @property {number} duration
 * @property {string} type
 * @property {number} ts
 * @property {number} size
 */
interface NetworkEntry {
  method: string;
  url: string;
  status: number;
  duration: number;
  type: string;
  ts: number;
  size: number;
}

/**
 * @typedef {object} ConsoleEntry
 * @property {string} level
 * @property {string[]} args
 * @property {number} ts
 */
interface ConsoleEntry {
  level: string;
  args: string[];
  ts: number;
}

declare global {
  var __bb_network_installed: boolean | undefined;
  var __bb_network_buffer: NetworkEntry[] | undefined;
  var __bb_network_dropped: number | undefined;
  var __bb_console_installed: boolean | undefined;
  var __bb_console_buffer: ConsoleEntry[] | undefined;
  var __bb_console_dropped: number | undefined;
}
