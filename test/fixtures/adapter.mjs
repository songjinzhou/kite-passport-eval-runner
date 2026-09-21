import process from "node:process";

let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;

switch (process.argv[2]) {
  case "echo":
    process.stdout.write(prompt);
    break;
  case "id":
    process.stdout.write(`case-${process.env.KITE_EVAL_ID}`);
    break;
  case "fail":
    process.stderr.write("adapter failed\n");
    process.exitCode = 7;
    break;
  case "hang":
    setTimeout(() => process.stdout.write("late"), 10_000);
    break;
  default:
    process.exitCode = 2;
}
