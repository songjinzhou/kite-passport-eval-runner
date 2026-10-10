#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadCases, runSuite, writeReports } from "../src/index.mjs";

const usage = `Usage:
  kite-passport-eval --input <evals.json> --adapter <executable> [options]

Options:
  --input <path>         Passport-compatible eval JSON (required)
  --adapter <path>       Agent adapter executable (required)
  --adapter-arg <value>  Adapter argument; repeat as needed
  --case <id>            Run one case; repeat as needed
  --output-dir <path>    Report directory (default: eval-results)
  --timeout-ms <number>  Per-case timeout (default: 120000)
  --retries <number>     Retry unsuccessful cases (default: 0)
  --jobs <number>        Concurrent processes (default: 1)
  --help                 Show help
`;

function value(argv, index, option, allowFlag = false) {
  const result = argv[index + 1];
  if (result === undefined || (!allowFlag && result.startsWith("--"))) {
    throw new Error(`${option} requires a value`);
  }
  return result;
}

function positiveInteger(raw, option) {
  const result = Number(raw);
  if (!Number.isInteger(result) || result < 1) {
    throw new Error(`${option} must be a positive integer`);
  }
  return result;
}

export function parseArgs(argv) {
  const options = {
    adapterArgs: [],
    caseIds: [],
    outputDirectory: "eval-results",
    timeoutMs: 120_000,
    retries: 0,
    jobs: 1,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--help") return { help: true };
    if (option === "--input") options.input = value(argv, index++, option);
    else if (option === "--adapter") options.adapter = value(argv, index++, option);
    else if (option === "--adapter-arg") {
      options.adapterArgs.push(value(argv, index++, option, true));
    } else if (option === "--case") {
      options.caseIds.push(positiveInteger(value(argv, index++, option), option));
    } else if (option === "--output-dir") {
      options.outputDirectory = value(argv, index++, option);
    } else if (option === "--timeout-ms") {
      options.timeoutMs = positiveInteger(value(argv, index++, option), option);
    } else if (option === "--retries") {
      options.retries = Number(value(argv, index++, option));
      if (!Number.isInteger(options.retries) || options.retries < 0) {
        throw new Error("--retries must be a non-negative integer");
      }
    } else if (option === "--jobs") {
      options.jobs = positiveInteger(value(argv, index++, option), option);
    } else throw new Error(`unknown option: ${option}`);
  }
  if (!options.input) throw new Error("--input is required");
  if (!options.adapter) throw new Error("--adapter is required");
  return options;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(usage);
    return;
  }
  try {
    const allCases = await loadCases(options.input);
    const cases = options.caseIds.length
      ? allCases.filter(({ id }) => options.caseIds.includes(id))
      : allCases;
    const missing = options.caseIds.filter(
      (id) => !cases.some((item) => item.id === id),
    );
    if (missing.length) throw new Error(`unknown eval id(s): ${missing.join(", ")}`);
    const report = await runSuite(cases, options);
    const paths = await writeReports(report, options.outputDirectory);
    process.stdout.write(
      `Evaluated ${report.summary.total} case(s): ${report.summary.passed} passed (${(
        report.summary.passRate * 100
      ).toFixed(2)}%).\nJSON: ${path.resolve(paths.json)}\nMarkdown: ${path.resolve(paths.markdown)}\n`,
    );
    if (report.summary.passed !== report.summary.total) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`Eval runner error: ${error.message}\n`);
    process.exitCode = 2;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  await main();
}
