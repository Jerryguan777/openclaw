/**
 * GAIA Layer 0 — Simplified tool factory.
 *
 * Only 8 tools:
 *   read, write, edit  (file ops — from pi-coding-agent)
 *   exec               (shell/Python — from openclaw bash-tools)
 *   web_search          (internet search)
 *   web_fetch           (URL content extraction)
 *   browser             (Playwright browser automation)
 *   image               (vision model image analysis)
 */

import {
  codingTools,
  createEditTool,
  createReadTool,
  createWriteTool,
  readTool,
} from "@mariozechner/pi-coding-agent";
import type { AnyAgentTool } from "../agents/pi-tools.types.js";
import type { OpenClawConfig } from "../config/config.js";
import { createExecTool } from "../agents/bash-tools.js";
import { createOpenClawReadTool } from "../agents/pi-tools.read.js";
import { normalizeToolParameters } from "../agents/pi-tools.schema.js";
import { createBrowserTool } from "../agents/tools/browser-tool.js";
import { createImageTool } from "../agents/tools/image-tool.js";
import { createWebFetchTool, createWebSearchTool } from "../agents/tools/web-tools.js";

export function createGaiaTools(options: {
  workspaceDir: string;
  agentDir: string;
  config?: OpenClawConfig;
  modelHasVision?: boolean;
  abortSignal?: AbortSignal;
}): AnyAgentTool[] {
  const workspaceRoot = options.workspaceDir;

  // --- File tools from pi-coding-agent (read, write, edit) ---
  const fileTools = (codingTools as unknown as AnyAgentTool[]).flatMap((tool) => {
    if (tool.name === readTool.name) {
      const freshReadTool = createReadTool(workspaceRoot);
      return [createOpenClawReadTool(freshReadTool)];
    }
    if (tool.name === "write") {
      return [createWriteTool(workspaceRoot) as unknown as AnyAgentTool];
    }
    if (tool.name === "edit") {
      return [createEditTool(workspaceRoot) as unknown as AnyAgentTool];
    }
    // Skip bash (replaced by exec) and any other pi defaults
    return [];
  });

  // --- Exec tool (shell commands, Python execution) ---
  const execTool = createExecTool({
    cwd: workspaceRoot,
    allowBackground: true,
    scopeKey: "gaia-eval",
  });

  // --- Web tools ---
  const webSearchTool = createWebSearchTool({
    config: options.config,
    sandboxed: false,
  });
  const webFetchTool = createWebFetchTool({
    config: options.config,
    sandboxed: false,
  });

  // --- Browser tool (Playwright) ---
  const browserTool = createBrowserTool({
    allowHostControl: true,
  });

  // --- Image tool (vision model) ---
  const imageTool = options.agentDir?.trim()
    ? createImageTool({
        config: options.config,
        agentDir: options.agentDir,
        modelHasVision: options.modelHasVision,
      })
    : null;

  const tools: AnyAgentTool[] = [
    ...fileTools,
    execTool as unknown as AnyAgentTool,
    ...(webSearchTool ? [webSearchTool] : []),
    ...(webFetchTool ? [webFetchTool] : []),
    browserTool,
    ...(imageTool ? [imageTool] : []),
  ];

  // Normalize JSON schemas for provider compatibility
  return tools.map(normalizeToolParameters);
}
