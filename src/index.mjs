import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function validateCase(value, index) {
  const label = `eval at index ${index}`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  if (!Number.isInteger(value.id) || value.id < 1) {
    throw new TypeError(`${label} must have a positive integer id`);
  }
  for (const field of ["prompt", "expected_output"]) {
    if (typeof value[field] !== "string" || value[field].trim() === "") {
      throw new TypeError(`${label}.${field} must be a non-empty string`);
    }
  }
  if (
    !Array.isArray(value.assertions) ||
    value.assertions.length === 0 ||
    value.assertions.some(
      (assertion) => typeof assertion !== "string" || assertion.trim() === "",
    )
  ) {
    throw new TypeError(`${label}.assertions must contain non-empty strings`);
  }
}

export async function loadCases(inputPath) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(inputPath, "utf8"));
  } catch (error) {
    throw new Error(`unable to read ${inputPath}: ${error.message}`, {
      cause: error,
    });
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new TypeError("eval input must be a non-empty JSON array");
  }
  const ids = new Set();
  parsed.forEach((value, index) => {
    validateCase(value, index);
    if (ids.has(value.id)) throw new TypeError(`duplicate eval id ${value.id}`);
    ids.add(value.id);
  });
  return parsed;
}

export function gradeTranscript(evalCase, transcript) {
  const assertions = evalCase.assertions.map((text) => ({
    text,
    passed: transcript.includes(text),
  }));
  const missingAssertions = assertions
    .filter(({ passed }) => !passed)
    .map(({ text }) => text);
  return {
    passed: missingAssertions.length === 0,
    assertions,
    missingAssertions,
  };
}

function execute(evalCase, options) {
  return new Promise((resolve) => {
    const started = performance.now();
    let stdout = "";
    let stderr = "";
    let spawnError;
    let timedOut = false;
    const child = spawn(options.adapter, options.adapterArgs ?? [], {
      env: { ...process.env, KITE_EVAL_ID: String(evalCase.id) },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => (spawnError = error));
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode,
        signal,
        spawnError,
        timedOut,
        durationMs: Math.round((performance.now() - started) * 100) / 100,
      });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(evalCase.prompt);
  });
}

export async function runCase(evalCase, options) {
  validateCase(evalCase, 0);
  if (!options.adapter) throw new TypeError("adapter is required");
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new TypeError("timeoutMs must be a positive integer");
  }
  const execution = await execute(evalCase, options);
  const base = {
    id: evalCase.id,
    prompt: evalCase.prompt,
    expectedOutput: evalCase.expected_output,
    expectedAssertions: evalCase.assertions,
    transcript: execution.stdout,
    stderr: execution.stderr,
    exitCode: execution.exitCode,
    signal: execution.signal,
    durationMs: execution.durationMs,
    timedOut: execution.timedOut,
  };
  if (execution.timedOut) {
    return {
      ...base,
      status: "timeout",
      assertions: [],
      missingAssertions: [...evalCase.assertions],
      error: `adapter exceeded timeout of ${options.timeoutMs} ms`,
    };
  }
  if (execution.spawnError || execution.exitCode !== 0) {
    return {
      ...base,
      status: "error",
      assertions: [],
      missingAssertions: [...evalCase.assertions],
      error:
        execution.spawnError?.message ??
        `adapter exited with code ${execution.exitCode}`,
    };
  }
  const grade = gradeTranscript(evalCase, execution.stdout);
  return {
    ...base,
    status: grade.passed ? "passed" : "failed",
    ...grade,
  };
}

export async function runSuite(cases, options) {
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new TypeError("at least one eval case is required");
  }
  if (!Number.isInteger(options.jobs) || options.jobs < 1) {
    throw new TypeError("jobs must be a positive integer");
  }
  const startedAt = new Date();
  const results = new Array(cases.length);
  let cursor = 0;
  async function worker() {
    while (cursor < cases.length) {
      const index = cursor++;
      results[index] = await runCase(cases[index], options);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(options.jobs, cases.length) }, worker),
  );
  const count = (status) => results.filter((item) => item.status === status).length;
  const passed = count("passed");
  const finishedAt = new Date();
  return {
    schemaVersion: 1,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt - startedAt,
    environment: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      ci: process.env.CI === "true",
    },
    configuration: {
      adapter: options.adapter,
      adapterArgs: options.adapterArgs ?? [],
      timeoutMs: options.timeoutMs,
      jobs: options.jobs,
    },
    summary: {
      total: results.length,
      passed,
      failed: count("failed"),
      errors: count("error"),
      timedOut: count("timeout"),
      passRate: passed / results.length,
    },
    results,
  };
}

function markdown(report) {
  const percent = (report.summary.passRate * 100).toFixed(2);
  const lines = [
    "# Kite Passport Eval Report",
    "",
    `- Started: ${report.startedAt}`,
    `- Adapter: \`${report.configuration.adapter}\``,
    `- Result: ${report.summary.passed}/${report.summary.total} (${percent}%)`,
    "",
    "| ID | Status | Duration | Missing assertions |",
    "|---:|:---:|---:|---|",
  ];
  for (const result of report.results) {
    const missing =
      result.missingAssertions.map((value) => value.replaceAll("|", "\\|")).join(", ") ||
      "—";
    lines.push(
      `| ${result.id} | ${result.status.toUpperCase()} | ${result.durationMs} ms | ${missing} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function writeReports(report, outputDirectory) {
  await mkdir(outputDirectory, { recursive: true });
  const json = path.join(outputDirectory, "report.json");
  const markdownPath = path.join(outputDirectory, "report.md");
  await Promise.all([
    writeFile(json, `${JSON.stringify(report, null, 2)}\n`),
    writeFile(markdownPath, markdown(report)),
  ]);
  return { json, markdown: markdownPath };
}
