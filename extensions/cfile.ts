/**
 * Quickfix file generator for vim/nvim.
 *
 * Scans the current session branch for files changed by edit/write tools
 * and writes a quickfix-format file loadable via `:cfile <path>`.
 *
 * Edit operations emit one entry per diff hunk (parsed from unified diff
 * headers). Write operations emit a single entry at line 1.
 *
 * Output format: <relative-path>:<line>:<col>: <line-content>
 *
 * Usage: /cfile
 * Output: /tmp/pi-qf-<session>-<timestamp>.qf
 *
 * The output path is automatically copied to the system clipboard.
 */

import type { ExtensionAPI, SessionEntry } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

type Change = {
  absolutePath: string;
  line: number;
};

/** Copy text to system clipboard (macOS only for now). */
function copyToClipboard(text: string): boolean {
  try {
    if (process.platform === "darwin") {
      execSync("pbcopy", { input: text });
      return true;
    }
    // Simple fallback for other platforms could be added here
    return false;
  } catch {
    return false;
  }
}

/** Parse unified diff hunk headers to extract starting lines in the new file. */
function parseHunkLines(diff: string): number[] {
  const lines: number[] = [];
  for (const match of diff.matchAll(
    /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/gm,
  )) {
    lines.push(Number(match[1]));
  }
  return lines;
}

/** Strip leading @ that some models prepend to paths. */
const stripAtPrefix = (p: string): string =>
  p.startsWith("@") ? p.slice(1) : p;

type ContentBlock = {
  type?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
};

/**
 * Walk session branch to collect every edit/write change with its target line.
 *
 * Two-pass approach:
 *   1. Collect tool call IDs from assistant messages for edit/write calls.
 *   2. Match tool results to extract details (firstChangedLine for edits).
 */
function collectChanges(entries: SessionEntry[], cwd: string): Change[] {
  const toolCalls = new Map<
    string,
    { filePath: string; toolName: "edit" | "write" }
  >();

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = entry.message;

    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content as ContentBlock[]) {
        if (
          block.type !== "toolCall" ||
          (block.name !== "edit" && block.name !== "write")
        )
          continue;

        const rawPath = block.arguments?.path;
        if (typeof rawPath !== "string") continue;

        toolCalls.set(block.id!, {
          filePath: stripAtPrefix(rawPath),
          toolName: block.name as "edit" | "write",
        });
      }
    }
  }

  const changes: Change[] = [];

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (msg.role !== "toolResult") continue;

    const call = toolCalls.get(msg.toolCallId);
    if (!call) continue;
    if (msg.isError) continue;

    const absolutePath = path.isAbsolute(call.filePath)
      ? call.filePath
      : path.resolve(cwd, call.filePath);

    if (call.toolName === "edit" && msg.details) {
      const details = msg.details as {
        diff?: string;
        firstChangedLine?: number;
      };
      const hunkLines = details.diff ? parseHunkLines(details.diff) : [];
      if (hunkLines.length > 0) {
        for (const line of hunkLines) {
          changes.push({ absolutePath, line });
        }
      } else {
        // Fallback: single entry at firstChangedLine or line 1
        changes.push({ absolutePath, line: details.firstChangedLine ?? 1 });
      }
    } else {
      // write tool — no diff available, point to start of file
      changes.push({ absolutePath, line: 1 });
    }
  }

  return changes;
}

/** Read a single line from a file (1-indexed). Returns empty string on failure. */
function readLine(filePath: string, lineNumber: number): string {
  if (!existsSync(filePath)) return "";
  try {
    const content = readFileSync(filePath, "utf8");
    return content.split("\n")[lineNumber - 1] ?? "";
  } catch {
    return "";
  }
}

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("cfile", {
    description: "Generate vim quickfix file of session changes",
    handler: async (args, ctx) => {
      const entries = ctx.sessionManager.getBranch();
      const changes = collectChanges(entries, ctx.cwd);

      if (changes.length === 0) {
        ctx.ui.notify("No changes tracked in this session", "warning");
        return;
      }

      const lines: string[] = [];
      for (const change of changes) {
        const content = readLine(change.absolutePath, change.line);
        const displayPath = path.relative(ctx.cwd, change.absolutePath);
        lines.push(`${displayPath}:${change.line}:1: ${content}`);
      }

      // Generate a session-specific filename with timestamp in OS temp dir
      const sessionFile = ctx.sessionManager.getSessionFile();
      const sessionName = sessionFile
        ? path.basename(sessionFile, ".jsonl")
        : "ephemeral";
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `pi-qf-${sessionName}-${timestamp}.qf`;
      const outputPath = path.join(os.tmpdir(), filename);

      writeFileSync(outputPath, lines.join("\n") + "\n", "utf8");

      const copied = copyToClipboard(outputPath);
      const clipboardMsg = copied ? " (copied to clipboard)" : "";

      ctx.ui.notify(`Written ${outputPath}${clipboardMsg}`, "info");
    },
  });
}
