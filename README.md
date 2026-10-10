# Kite Passport Eval Runner

An independent, zero-dependency Node.js runner for behavioral evals in the
Kite Agent Passport ecosystem. It turns the Passport eval JSON contract into
repeatable subprocess runs, deterministic assertion grading, and auditable
JSON/Markdown reports.

This is an original personal repository, not a fork. The official
[`gokite-ai/passport-skills`](https://github.com/gokite-ai/passport-skills)
repository is used only as the technical reference for the eval data shape.

## Why

Passport Skills publishes behavioral cases shaped as:

```json
{
  "id": 1,
  "prompt": "Show me my recent activity",
  "expected_output": "Expected agent behavior",
  "assertions": ["kpass activity", "--output json"]
}
```

Manual dispatch and grading do not scale across the complete regression set.
This runner gives each case an isolated adapter process, sends only the prompt,
keeps the answer key inside the grader, and records failures precisely.

## Requirements

- Node.js 20 or newer
- An agent adapter executable that reads a prompt from `stdin` and writes its
  final transcript to `stdout`
- A Passport-compatible `evals.json`

## Run

Clone this repository, then download the current official eval definitions:

```bash
curl -L \
  https://raw.githubusercontent.com/gokite-ai/passport-skills/main/evals/evals.json \
  -o evals.json
```

Run every case:

```bash
node bin/kite-passport-eval.mjs \
  --input evals.json \
  --adapter /path/to/agent-adapter \
  --jobs 4 \
  --timeout-ms 120000 \
  --retries 2
```

`--retries` reruns an unsuccessful case in a fresh adapter process, up to the
specified number of extra attempts. It defaults to `0`; the report records each
attempt's status and output, while the case status reflects the final attempt
or the first successful attempt. Since adapters may call paid models, retries
can increase usage and cost.

Pass adapter arguments directly without a shell, or select cases during
development:

```bash
node bin/kite-passport-eval.mjs \
  --input evals.json \
  --adapter /path/to/agent-adapter \
  --adapter-arg --non-interactive \
  --case 4 \
  --case 5
```

The runner provides `KITE_EVAL_ID` to the adapter for correlation. It does not
expose `expected_output` or `assertions`, preventing answer-key leakage.

## Adapter contract

A minimal shell adapter can forward the prompt to any local agent CLI:

```bash
#!/usr/bin/env bash
set -euo pipefail
prompt=$(cat)
your-agent --print "$prompt"
```

The adapter must:

1. Read the full prompt from standard input.
2. Write only the transcript to standard output.
3. Write diagnostics to standard error.
4. Exit non-zero when agent execution fails.

## Reports and exit codes

The default `eval-results/` directory contains:

- `report.json`: environment, configuration, raw transcripts, and
  assertion-level results for automation.
- `report.md`: compact human review table.
- Each JSON case includes its attempt history, and the Markdown table shows the
  total attempt count and combined duration.

Exit status `0` means every selected case passed. Status `1` means at least one
case failed, errored, or timed out. Status `2` means the configuration or input
was invalid.

## Verification

```bash
npm test
npm run test:coverage
```

CI runs the suite on Node.js 20 for runtime compatibility and uses Node.js 22
to enforce at least 80% line, function, and branch coverage (the native
coverage-threshold flags were added after Node.js 20).

## Security properties

- Adapters are launched directly with `spawn(..., { shell: false })`; eval
  prompts cannot become shell syntax.
- Each case runs in a fresh process and is killed after its deadline.
- Grading criteria never enter the adapter environment.
- Adapter arguments are recorded in reports, so credentials should stay in the
  adapter's normal authentication store rather than command-line arguments.

## License

MIT
