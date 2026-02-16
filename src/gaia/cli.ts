/**
 * GAIA Layer 0 — CLI entry point.
 *
 * Usage:
 *   npx tsx src/gaia/cli.ts --question "What is ..."
 *   npx tsx src/gaia/cli.ts --question "What is ..." --file /path/to/attachment.pdf
 *   npx tsx src/gaia/cli.ts --question "What is ..." --provider openai --model gpt-5.2
 *
 * JSON output mode (for eval harness):
 *   npx tsx src/gaia/cli.ts --json --question "What is ..."
 */

import { parseArgs } from "node:util";
import { runGaiaQuestion } from "./runner.js";

async function main() {
  const { values } = parseArgs({
    options: {
      question: { type: "string", short: "q" },
      file: { type: "string", short: "f" },
      provider: { type: "string", short: "p", default: "anthropic" },
      model: { type: "string", short: "m", default: "claude-opus-4-6" },
      thinking: { type: "string", short: "t", default: "high" },
      timeout: { type: "string", default: "600000" },
      workspace: { type: "string", short: "w" },
      "api-key": { type: "string", short: "k" },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (!values.question) {
    console.error("Usage: npx tsx src/gaia/cli.ts --question 'Your question here'");
    console.error("");
    console.error("Options:");
    console.error("  -q, --question   The GAIA question text (required)");
    console.error("  -f, --file       Path to attached file");
    console.error("  -p, --provider   LLM provider (default: anthropic)");
    console.error("  -m, --model      Model ID (default: claude-opus-4-6)");
    console.error("  -t, --thinking   Thinking level (default: high)");
    console.error("  --timeout        Timeout in ms (default: 600000)");
    console.error("  -w, --workspace  Working directory for temp files");
    console.error("  -k, --api-key    API key (overrides env/auth-profiles)");
    console.error("  --json           Output result as JSON (for eval harness)");
    process.exit(1);
  }

  const result = await runGaiaQuestion({
    question: values.question,
    filePath: values.file,
    provider: values.provider,
    model: values.model,
    thinkLevel: values.thinking,
    timeoutMs: Number.parseInt(values.timeout ?? "600000", 10),
    workspaceDir: values.workspace,
    apiKey: values["api-key"],
  });

  if (values.json) {
    console.log(JSON.stringify(result));
  } else {
    console.log("=".repeat(60));
    console.log("GAIA Agent Result");
    console.log("=".repeat(60));
    console.log(`Session: ${result.sessionId}`);
    console.log(`Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
    console.log(`Timed out: ${result.timedOut}`);
    if (result.error) {
      console.log(`Error: ${result.error}`);
    }
    console.log("-".repeat(60));
    console.log("Full response:");
    console.log(result.fullResponse);
    console.log("-".repeat(60));
    console.log(`FINAL ANSWER: ${result.finalAnswer}`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
