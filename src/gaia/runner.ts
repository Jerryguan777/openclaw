/**
 * GAIA Layer 0 — Simplified agent runner.
 *
 * Directly uses Pi SDK's `createAgentSession()`, completely bypassing
 * OpenClaw's Gateway, channels, routing, hooks, and plugin system.
 */

import { streamSimple } from "@mariozechner/pi-ai";
import { createAgentSession, SessionManager, SettingsManager } from "@mariozechner/pi-coding-agent";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
import { getApiKeyForModel } from "../agents/model-auth.js";
import { resolveModel } from "../agents/pi-embedded-runner/model.js";
import { toToolDefinitions } from "../agents/pi-tool-definition-adapter.js";
import { loadConfig } from "../config/config.js";
import { buildGaiaSystemPrompt } from "./system-prompt.js";
import { createGaiaTools } from "./tools.js";

export type GaiaRunParams = {
  /** The question text */
  question: string;
  /** Optional path to an attached file */
  filePath?: string;
  /** LLM provider (default: "anthropic") */
  provider?: string;
  /** Model ID (default: "claude-opus-4-6") */
  model?: string;
  /** Thinking level (default: "high") */
  thinkLevel?: string;
  /** Timeout in ms (default: 600000 = 10 minutes) */
  timeoutMs?: number;
  /** Working directory for temporary files */
  workspaceDir?: string;
  /** Agent directory for auth/model discovery */
  agentDir?: string;
  /** Direct API key (overrides env/auth-profiles lookup) */
  apiKey?: string;
};

export type GaiaRunResult = {
  /** Full assistant response text */
  fullResponse: string;
  /** Extracted final answer */
  finalAnswer: string;
  /** Session ID used */
  sessionId: string;
  /** Duration in milliseconds */
  durationMs: number;
  /** Whether the run was aborted/timed out */
  timedOut: boolean;
  /** Error message if any */
  error?: string;
};

/**
 * Extract "FINAL ANSWER: xxx" from the agent's response.
 */
function extractFinalAnswer(response: string): string {
  const match = response.match(/FINAL ANSWER:\s*(.+?)(?:\n|$)/i);
  if (match) {
    return match[1].trim();
  }
  // Fallback: last non-empty line
  const lines = response
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : "";
}

/**
 * Run a single GAIA question through the agent.
 */
export async function runGaiaQuestion(params: GaiaRunParams): Promise<GaiaRunResult> {
  const started = Date.now();
  const provider = params.provider ?? "anthropic";
  const modelId = params.model ?? "claude-opus-4-6";
  const timeoutMs = params.timeoutMs ?? 600_000;
  const agentDir = params.agentDir ?? resolveOpenClawAgentDir();
  const workspaceDir = params.workspaceDir ?? path.join(agentDir, "gaia-workspace");
  const sessionId = `gaia-${crypto.randomUUID()}`;
  const sessionFile = path.join(agentDir, "sessions", `${sessionId}.jsonl`);

  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });

  // --- Load config ---
  const config = loadConfig();

  // --- Resolve model and auth ---
  const {
    model,
    error: modelError,
    authStorage,
    modelRegistry,
  } = resolveModel(provider, modelId, agentDir, config);
  if (!model) {
    return {
      fullResponse: "",
      finalAnswer: "",
      sessionId,
      durationMs: Date.now() - started,
      timedOut: false,
      error: modelError ?? `Unknown model: ${provider}/${modelId}`,
    };
  }

  // Set API key — direct param > env var > auth-profiles
  if (params.apiKey) {
    authStorage.setRuntimeApiKey(model.provider, params.apiKey);
  } else {
    try {
      const apiKeyInfo = await getApiKeyForModel({
        model,
        cfg: config,
        store: { profiles: {}, version: 1 },
        agentDir,
      });
      if (apiKeyInfo.apiKey) {
        authStorage.setRuntimeApiKey(model.provider, apiKeyInfo.apiKey);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        fullResponse: "",
        finalAnswer: "",
        sessionId,
        durationMs: Date.now() - started,
        timedOut: false,
        error: `API key error: ${msg}`,
      };
    }
  }

  // --- Build prompt ---
  let prompt = params.question;
  if (params.filePath) {
    const absPath = path.resolve(params.filePath);
    // Copy file to workspace so agent can access it
    const destPath = path.join(workspaceDir, path.basename(absPath));
    try {
      await fs.copyFile(absPath, destPath);
      prompt += `\n\n[Attached file: ${destPath}]`;
    } catch {
      prompt += `\n\n[Attached file (original path): ${absPath}]`;
    }
  }

  // --- Create tools ---
  const modelHasVision = model.input?.includes("image") ?? false;
  const tools = createGaiaTools({
    workspaceDir,
    agentDir,
    config,
    modelHasVision,
  });

  // --- Build system prompt ---
  const systemPrompt = buildGaiaSystemPrompt({
    workspaceDir,
    tools,
    provider,
    model: modelId,
  });

  // --- Create agent session ---
  const sessionManager = SessionManager.open(sessionFile);
  const settingsManager = SettingsManager.create(workspaceDir, agentDir);

  const thinkLevel = params.thinkLevel ?? "high";
  const customTools = toToolDefinitions(tools);

  const { session } = await createAgentSession({
    cwd: workspaceDir,
    agentDir,
    authStorage,
    modelRegistry,
    model,
    thinkingLevel: thinkLevel as "off" | "minimal" | "low" | "medium" | "high",
    tools: [],
    customTools,
    sessionManager,
    settingsManager,
  });

  // Override system prompt
  session.agent.setSystemPrompt(systemPrompt);
  const mutableSession = session as unknown as {
    _baseSystemPrompt?: string;
    _rebuildSystemPrompt?: (toolNames: string[]) => string;
  };
  mutableSession._baseSystemPrompt = systemPrompt;
  mutableSession._rebuildSystemPrompt = () => systemPrompt;

  // Force stable streamFn
  session.agent.streamFn = streamSimple;

  // --- Run with timeout ---
  const abortController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abortController.abort(new Error("GAIA question timed out"));
    void session.abort();
  }, timeoutMs);

  // Collect assistant text
  let fullResponse = "";

  try {
    await session.prompt(prompt);

    // Extract response from all assistant messages in the session.
    // AgentMessage = Message (UserMessage | AssistantMessage | ToolResultMessage).
    // AssistantMessage has content: (TextContent | ThinkingContent | ToolCall)[].
    const messages = session.messages;
    const textParts: string[] = [];
    for (const msg of messages) {
      if (msg.role !== "assistant") {
        continue;
      }
      const content = (msg as { content: Array<{ type: string; text?: string }> }).content;
      if (!Array.isArray(content)) {
        continue;
      }
      for (const block of content) {
        if (block.type === "text" && block.text) {
          textParts.push(block.text);
        }
      }
    }
    fullResponse = textParts.join("\n");
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      fullResponse,
      finalAnswer: extractFinalAnswer(fullResponse),
      sessionId,
      durationMs: Date.now() - started,
      timedOut,
      error: errorMsg,
    };
  } finally {
    clearTimeout(timer);
    session.dispose();
  }

  return {
    fullResponse,
    finalAnswer: extractFinalAnswer(fullResponse),
    sessionId,
    durationMs: Date.now() - started,
    timedOut,
  };
}
