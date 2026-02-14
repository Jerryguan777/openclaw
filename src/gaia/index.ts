/**
 * GAIA Layer 0 — Simplified general-purpose agent for GAIA benchmark evaluation.
 *
 * This module provides a streamlined agent that bypasses OpenClaw's Gateway,
 * channel system, and plugin infrastructure. It directly uses the Pi SDK's
 * agent loop with only 8 tools needed for GAIA tasks:
 *
 *   File ops:  read, write, edit
 *   Execution: exec (shell/Python)
 *   Web:       web_search, web_fetch
 *   Browser:   browser (Playwright)
 *   Vision:    image
 *
 * Entry points:
 *   - runGaiaQuestion()  — programmatic API (TypeScript)
 *   - src/gaia/cli.ts    — CLI interface (for Python eval harness)
 *   - gaia-eval/eval.py  — full GAIA evaluation harness
 */

export { runGaiaQuestion, type GaiaRunParams, type GaiaRunResult } from "./runner.js";
export { createGaiaTools } from "./tools.js";
export { buildGaiaSystemPrompt } from "./system-prompt.js";
