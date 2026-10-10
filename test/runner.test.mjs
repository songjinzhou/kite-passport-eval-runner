import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  gradeTranscript,
  loadCases,
  runCase,
  runSuite,
  writeReports,
} from "../src/index.mjs";
import { parseArgs } from "../bin/kite-passport-eval.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const adapter = path.join(directory, "fixtures", "adapter.mjs");
const cli = path.join(directory, "..", "bin", "kite-passport-eval.mjs");
const execFileAsync = promisify(execFile);

function evalCase(overrides = {}) {
  return {
    id: 1,
    prompt: "alpha beta",
    expected_output: "contains both markers",
    assertions: ["alpha", "beta"],
    ...overrides,
  };
}

test("loads the Passport eval JSON contract", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "kite-evals-"));
  const input = path.join(temp, "evals.json");
  await writeFile(input, JSON.stringify([evalCase()]));
  assert.deepEqual(await loadCases(input), [evalCase()]);
});

test("rejects malformed and duplicate eval cases", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "kite-invalid-"));
  const duplicate = path.join(temp, "duplicate.json");
  const malformed = path.join(temp, "malformed.json");
  await writeFile(duplicate, JSON.stringify([evalCase(), evalCase()]));
  await writeFile(malformed, JSON.stringify([evalCase({ assertions: [""] })]));
  await assert.rejects(loadCases(duplicate), /duplicate eval id 1/i);
  await assert.rejects(loadCases(malformed), /non-empty strings/i);
});

test("rejects unreadable, empty, and structurally invalid inputs", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "kite-schema-"));
  const fixtures = [
    ["invalid.json", "not json", /unable to read/i],
    ["empty.json", "[]", /non-empty JSON array/i],
    ["object.json", "{}", /non-empty JSON array/i],
    ["null.json", "[null]", /must be an object/i],
    ["id.json", JSON.stringify([evalCase({ id: 0 })]), /positive integer id/i],
    ["prompt.json", JSON.stringify([evalCase({ prompt: "" })]), /prompt must be/i],
    [
      "expected.json",
      JSON.stringify([evalCase({ expected_output: null })]),
      /expected_output must be/i,
    ],
    [
      "assertions.json",
      JSON.stringify([evalCase({ assertions: "alpha" })]),
      /assertions must contain/i,
    ],
  ];
  await assert.rejects(loadCases(path.join(temp, "missing.json")), /unable to read/i);
  for (const [name, contents, pattern] of fixtures) {
    const input = path.join(temp, name);
    await writeFile(input, contents);
    await assert.rejects(loadCases(input), pattern);
  }
});

test("grades each literal assertion", () => {
  assert.deepEqual(gradeTranscript(evalCase(), "alpha only"), {
    passed: false,
    assertions: [
      { text: "alpha", passed: true },
      { text: "beta", passed: false },
    ],
    missingAssertions: ["beta"],
  });
});

test("isolates the adapter and keeps grading criteria private", async () => {
  const result = await runCase(evalCase(), {
    adapter: process.execPath,
    adapterArgs: [adapter, "echo"],
    timeoutMs: 1_000,
  });
  assert.equal(result.status, "passed");
  assert.equal(result.transcript, "alpha beta");
  assert.equal(result.exitCode, 0);
  assert.equal(result.missingAssertions.length, 0);
});

test("records adapter errors and timeouts", async () => {
  const failed = await runCase(evalCase(), {
    adapter: process.execPath,
    adapterArgs: [adapter, "fail"],
    timeoutMs: 1_000,
  });
  const timedOut = await runCase(evalCase(), {
    adapter: process.execPath,
    adapterArgs: [adapter, "hang"],
    timeoutMs: 40,
  });
  assert.equal(failed.status, "error");
  assert.equal(failed.exitCode, 7);
  assert.match(failed.stderr, /adapter failed/);
  assert.equal(timedOut.status, "timeout");
  assert.match(timedOut.error, /40 ms/);
});

test("records adapter spawn failures and validates execution options", async () => {
  const missing = await runCase(evalCase(), {
    adapter: path.join(os.tmpdir(), "missing-kite-adapter"),
    adapterArgs: [],
    timeoutMs: 1_000,
  });
  assert.equal(missing.status, "error");
  assert.match(missing.error, /ENOENT/);
  await assert.rejects(runCase(evalCase(), { timeoutMs: 1 }), /adapter is required/);
  await assert.rejects(
    runCase(evalCase(), { adapter: "agent", timeoutMs: 0 }),
    /timeoutMs must be a positive integer/,
  );
  await assert.rejects(runSuite([], { jobs: 1 }), /at least one eval case/);
  await assert.rejects(
    runSuite([evalCase()], { jobs: 0 }),
    /jobs must be a positive integer/,
  );
});

test("runs cases concurrently without reordering results", async () => {
  const report = await runSuite(
    [
      evalCase({ id: 2, assertions: ["case-2"] }),
      evalCase({ id: 1, assertions: ["case-1"] }),
    ],
    {
      adapter: process.execPath,
      adapterArgs: [adapter, "id"],
      timeoutMs: 1_000,
      retries: 0,
      jobs: 2,
    },
  );
  assert.deepEqual(report.results.map(({ id }) => id), [2, 1]);
  assert.deepEqual(report.summary, {
    total: 2,
    passed: 2,
    failed: 0,
    errors: 0,
    timedOut: 0,
    passRate: 1,
  });
});

test("retries unsuccessful attempts and retains their audit details", async () => {
  const result = await runCase(evalCase(), {
    adapter: process.execPath,
    adapterArgs: [adapter, "retry-once"],
    timeoutMs: 1_000,
    retries: 1,
  });
  assert.equal(result.status, "passed");
  assert.equal(result.attemptCount, 2);
  assert.equal(result.retriesUsed, 1);
  assert.deepEqual(result.attempts.map(({ status }) => status), ["failed", "passed"]);
  assert.equal(result.attempts[0].missingAssertions[0], "alpha");
});

test("writes JSON and Markdown audit reports", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "kite-report-"));
  const report = await runSuite([evalCase()], {
    adapter: process.execPath,
    adapterArgs: [adapter, "echo"],
    timeoutMs: 1_000,
    jobs: 1,
  });
  const paths = await writeReports(report, temp);
  const json = JSON.parse(await readFile(paths.json, "utf8"));
  const markdown = await readFile(paths.markdown, "utf8");
  assert.equal(json.summary.passed, 1);
  assert.match(markdown, /# Kite Passport Eval Report/);
  assert.match(markdown, /1\/1 \(100\.00%\)/);
  assert.match(markdown, /\| ID \| Status \| Attempts \| Duration \|/);
});

test("parses repeatable adapter arguments and case filters", () => {
  assert.deepEqual(
    parseArgs([
      "--input", "evals.json",
      "--adapter", "agent-cli",
      "--adapter-arg", "--print",
      "--case", "4",
      "--jobs", "2",
    ]),
    {
      input: "evals.json",
      adapter: "agent-cli",
      adapterArgs: ["--print"],
      caseIds: [4],
      outputDirectory: "eval-results",
      timeoutMs: 120_000,
      retries: 0,
      jobs: 2,
    },
  );
  assert.deepEqual(parseArgs(["--help"]), { help: true });
  assert.throws(() => parseArgs([]), /--input is required/);
  assert.throws(() => parseArgs(["--input", "x"]), /--adapter is required/);
  assert.throws(() => parseArgs(["--input"]), /requires a value/);
  assert.throws(
    () => parseArgs(["--input", "x", "--adapter", "x", "--unknown"]),
    /unknown option/,
  );
  assert.throws(
    () => parseArgs(["--input", "x", "--adapter", "x", "--jobs", "0"]),
    /positive integer/,
  );
  assert.equal(parseArgs(["--input", "x", "--adapter", "x", "--retries", "2"]).retries, 2);
  assert.throws(
    () => parseArgs(["--input", "x", "--adapter", "x", "--retries", "-1"]),
    /non-negative integer/,
  );
});

test("CLI produces a failing report and a non-zero status", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "kite-cli-"));
  const input = path.join(temp, "evals.json");
  const output = path.join(temp, "report");
  await writeFile(input, JSON.stringify([evalCase()]));
  await assert.rejects(
    execFileAsync(process.execPath, [
      cli,
      "--input", input,
      "--adapter", process.execPath,
      "--adapter-arg", adapter,
      "--adapter-arg", "id",
      "--output-dir", output,
    ]),
    (error) => error.code === 1 && /0 passed/.test(error.stdout),
  );
  const report = JSON.parse(
    await readFile(path.join(output, "report.json"), "utf8"),
  );
  assert.deepEqual(report.results[0].missingAssertions, ["alpha", "beta"]);
});

test("CLI supports successful case selection, help, and invalid ids", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "kite-cli-pass-"));
  const input = path.join(temp, "evals.json");
  await writeFile(
    input,
    JSON.stringify([evalCase({ id: 2, prompt: "case-2", assertions: ["case-2"] })]),
  );
  const { stdout } = await execFileAsync(process.execPath, [
    cli,
    "--input", input,
    "--adapter", process.execPath,
    "--adapter-arg", adapter,
    "--adapter-arg", "id",
    "--case", "2",
    "--output-dir", path.join(temp, "report"),
  ]);
  assert.match(stdout, /1 passed \(100\.00%\)/);

  const help = await execFileAsync(process.execPath, [cli, "--help"]);
  assert.match(help.stdout, /Usage:/);
  await assert.rejects(
    execFileAsync(process.execPath, [
      cli,
      "--input", input,
      "--adapter", process.execPath,
      "--case", "999",
    ]),
    (error) => error.code === 2 && /unknown eval id/.test(error.stderr),
  );
});
