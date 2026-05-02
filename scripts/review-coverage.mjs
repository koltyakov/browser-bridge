#!/usr/bin/env node
// @ts-check

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const summaryPath = path.join(repoRoot, 'coverage', 'coverage-summary.json');
const reviewLimit = parseReviewLimit(process.argv[2]) ?? 10;

/**
 * @typedef {{ total?: number, covered?: number, skipped?: number, pct?: number }} CoverageMetric
 * @typedef {{ lines?: CoverageMetric, statements?: CoverageMetric, functions?: CoverageMetric, branches?: CoverageMetric }} CoverageSummaryEntry
 * @typedef {{ filePath: string, linesPct: number, uncoveredLines: number, statementsPct: number, branchesPct: number, functionsPct: number }} CoverageRow
 */

const summary = /** @type {Record<string, CoverageSummaryEntry>} */ (
  await readCoverageSummary(summaryPath)
);
const lowestCoveredFiles = Object.entries(summary)
  .filter(([filePath]) => filePath !== 'total')
  .map(([filePath, entry]) => toCoverageRow(filePath, entry))
  .sort(compareCoverageRows)
  .slice(0, reviewLimit);

if (lowestCoveredFiles.length === 0) {
  throw new Error('No per-file coverage entries were found in coverage/coverage-summary.json.');
}

process.stdout.write(`Lowest-covered files (top ${lowestCoveredFiles.length} by line coverage)\n`);
process.stdout.write('Lines   Uncovered   Branches   Functions   Statements   File\n');

for (const row of lowestCoveredFiles) {
  process.stdout.write(
    `${formatPercent(row.linesPct)}   ${formatCount(row.uncoveredLines)}   ${formatPercent(row.branchesPct)}   ${formatPercent(row.functionsPct)}   ${formatPercent(row.statementsPct)}   ${row.filePath}\n`
  );
}

/**
 * @param {string} filePath
 * @returns {Promise<unknown>}
 */
async function readCoverageSummary(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new Error(
        `Missing coverage summary at ${filePath}. Run npm test before npm run coverage:review.`
      );
    }

    throw error;
  }
}

/**
 * @param {string} filePath
 * @param {CoverageSummaryEntry} entry
 * @returns {CoverageRow}
 */
function toCoverageRow(filePath, entry) {
  const lineMetric = entry.lines ?? {};
  const relativePath = path.isAbsolute(filePath) ? path.relative(repoRoot, filePath) : filePath;
  const totalLines = typeof lineMetric.total === 'number' ? lineMetric.total : 0;
  const coveredLines = typeof lineMetric.covered === 'number' ? lineMetric.covered : 0;

  return {
    filePath: relativePath || filePath,
    linesPct: metricPct(entry.lines),
    uncoveredLines: Math.max(totalLines - coveredLines, 0),
    statementsPct: metricPct(entry.statements),
    branchesPct: metricPct(entry.branches),
    functionsPct: metricPct(entry.functions),
  };
}

/**
 * @param {CoverageRow} left
 * @param {CoverageRow} right
 * @returns {number}
 */
function compareCoverageRows(left, right) {
  return (
    left.linesPct - right.linesPct ||
    right.uncoveredLines - left.uncoveredLines ||
    left.branchesPct - right.branchesPct ||
    left.filePath.localeCompare(right.filePath)
  );
}

/**
 * @param {CoverageMetric | undefined} metric
 * @returns {number}
 */
function metricPct(metric) {
  return typeof metric?.pct === 'number' ? metric.pct : 0;
}

/**
 * @param {number} value
 * @returns {string}
 */
function formatPercent(value) {
  return `${value.toFixed(2)}%`.padStart(7, ' ');
}

/**
 * @param {number} value
 * @returns {string}
 */
function formatCount(value) {
  return String(value).padStart(9, ' ');
}

/**
 * @param {string | undefined} value
 * @returns {number | null}
 */
function parseReviewLimit(value) {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer review limit, received: ${value}`);
  }

  return parsed;
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isMissingFileError(error) {
  return error instanceof Error && Reflect.get(error, 'code') === 'ENOENT';
}
