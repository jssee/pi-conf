import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  truncateHead,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import TurndownService from "turndown";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5MB
const DEFAULT_TIMEOUT = 30_000;
const MAX_TIMEOUT = 120_000;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

type Format = "text" | "markdown" | "html";

function acceptHeader(format: Format): string {
  switch (format) {
    case "markdown":
      return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1";
    case "text":
      return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1";
    case "html":
      return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, */*;q=0.1";
  }
}

function stripHtmlTags(html: string): string {
  // Remove head, script, style, and other non-content blocks entirely
  let text = html.replace(/<(head|script|style|noscript|iframe|object|embed)[^>]*>[\s\S]*?<\/\1>/gi, "");
  // Replace block-level tags with newlines
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|br|hr)[^>]*>/gi, "\n");
  text = text.replace(/<br[^>]*\/?>/gi, "\n");
  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, "");
  // Decode common entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
  // Collapse whitespace
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

// Tooltip/popup class prefixes to strip from HTML before markdown conversion.
// Turndown's code-block rule extracts textContent directly, bypassing element
// filters, so these must be removed from the raw HTML string.
const NOISE_MARKERS = [
  'twoslash-popup-container',     // Svelte/Shiki twoslash type-hover popups
  'rehype-twoslash-popover-content', // rehype-twoslash variant
];

/** Strip elements whose class contains a noise marker, respecting nested tags. */
function stripTooltipElements(html: string): string {
  const openTags = NOISE_MARKERS.map(m => `<span class="${m}">`);

  let result = "";
  let i = 0;
  while (i < html.length) {
    // Find the next noise-marker open tag
    let nearest = -1;
    let tagLen = 0;
    for (const tag of openTags) {
      const pos = html.indexOf(tag, i);
      if (pos !== -1 && (nearest === -1 || pos < nearest)) {
        nearest = pos;
        tagLen = tag.length;
      }
    }
    if (nearest === -1) {
      result += html.slice(i);
      break;
    }
    result += html.slice(i, nearest);

    // Walk forward past the matching </span>, tracking nesting depth
    let depth = 1;
    let j = nearest + tagLen;
    while (j < html.length && depth > 0) {
      if (html.startsWith("<span", j)) {
        depth++;
        const gt = html.indexOf(">", j);
        j = gt === -1 ? html.length : gt + 1;
      } else if (html.startsWith("</span>", j)) {
        depth--;
        j += 7; // "</span>".length
      } else {
        j++;
      }
    }
    i = j;
  }
  return result;
}

function htmlToMarkdown(html: string): string {
  const cleaned = stripTooltipElements(html);
  const turndown = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  });
  turndown.remove(["script", "style", "meta", "link"]);
  return turndown.turndown(cleaned);
}

interface WebfetchDetails {
  url: string;
  format: Format;
  contentType: string;
  truncated: boolean;
  fullOutputPath?: string;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "webfetch",
    label: "Web Fetch",
    description: [
      "Fetch content from a URL and return it as markdown, text, or HTML.",
      "Use when you need to read web pages, documentation, or any HTTP resource.",
      "The URL must start with http:// or https://.",
      `Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
    ].join(" "),
    promptGuidelines: [
      "Use webfetch to retrieve web content when the user provides a URL or asks about online resources.",
      "Default format is markdown; use 'text' for simpler extraction or 'html' for raw markup.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "The URL to fetch content from" }),
      format: Type.Optional(
        StringEnum(["text", "markdown", "html"] as const, {
          description:
            "Output format: markdown (default), text (plain text extraction), or html (raw)",
          default: "markdown",
        })
      ),
      timeout: Type.Optional(
        Type.Number({
          description: "Timeout in seconds (default 30, max 120)",
        })
      ),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const url = params.url;
      const format: Format = params.format ?? "markdown";

      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        throw new Error("URL must start with http:// or https://");
      }

      const timeout = Math.min(
        (params.timeout ?? DEFAULT_TIMEOUT / 1000) * 1000,
        MAX_TIMEOUT
      );

      // Create an abort controller that respects both timeout and caller signal
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      signal?.addEventListener("abort", () => controller.abort());

      try {
        const headers = {
          "User-Agent": USER_AGENT,
          Accept: acceptHeader(format),
          "Accept-Language": "en-US,en;q=0.9",
        };

        onUpdate?.({
          content: [{ type: "text", text: `Fetching ${url}...` }],
        });

        let response = await fetch(url, {
          signal: controller.signal,
          headers,
        });

        // Retry with honest UA if blocked by Cloudflare bot detection
        if (
          response.status === 403 &&
          response.headers.get("cf-mitigated") === "challenge"
        ) {
          response = await fetch(url, {
            signal: controller.signal,
            headers: { ...headers, "User-Agent": "pi-coding-agent" },
          });
        }

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        // Check content length before downloading
        const contentLength = response.headers.get("content-length");
        if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
          throw new Error(
            `Response too large: ${formatSize(parseInt(contentLength))} (limit ${formatSize(MAX_RESPONSE_SIZE)})`
          );
        }

        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > MAX_RESPONSE_SIZE) {
          throw new Error(
            `Response too large: ${formatSize(buffer.byteLength)} (limit ${formatSize(MAX_RESPONSE_SIZE)})`
          );
        }

        const contentType = response.headers.get("content-type") ?? "";
        const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";

        // Images: note them but don't return binary data
        if (mime.startsWith("image/") && mime !== "image/svg+xml") {
          return {
            content: [
              {
                type: "text",
                text: `Image fetched: ${url} (${mime}, ${formatSize(buffer.byteLength)})`,
              },
            ],
            details: {
              url,
              format,
              contentType: mime,
              truncated: false,
            } satisfies WebfetchDetails,
          };
        }

        const raw = new TextDecoder().decode(buffer);
        const isHtml = contentType.includes("text/html");

        let content: string;
        switch (format) {
          case "markdown":
            content = isHtml ? htmlToMarkdown(raw) : raw;
            break;
          case "text":
            content = isHtml ? stripHtmlTags(raw) : raw;
            break;
          case "html":
          default:
            content = raw;
            break;
        }

        // Truncate output
        const truncation = truncateHead(content, {
          maxLines: DEFAULT_MAX_LINES,
          maxBytes: DEFAULT_MAX_BYTES,
        });

        const details: WebfetchDetails = {
          url,
          format,
          contentType: mime,
          truncated: truncation.truncated,
        };

        let result = truncation.content;

        if (truncation.truncated) {
          const tempDir = mkdtempSync(join(tmpdir(), "pi-webfetch-"));
          const tempFile = join(tempDir, "output.txt");
          writeFileSync(tempFile, content);
          details.fullOutputPath = tempFile;

          result += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines`;
          result += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
          result += ` Full output: ${tempFile}]`;
        }

        return {
          content: [{ type: "text", text: result }],
          details,
        };
      } finally {
        clearTimeout(timer);
      }
    },

    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("webfetch "));
      text += theme.fg("accent", args.url ?? "");
      if (args.format && args.format !== "markdown") {
        text += theme.fg("muted", ` (${args.format})`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme, _context) {
      const details = result.details as WebfetchDetails | undefined;

      if (isPartial) {
        return new Text(theme.fg("warning", "Fetching..."), 0, 0);
      }

      if (!details) {
        const text =
          result.content[0]?.type === "text" ? result.content[0].text : "";
        return new Text(theme.fg("dim", text.slice(0, 120)), 0, 0);
      }

      let text = theme.fg("success", details.url);
      text += theme.fg("dim", ` ${details.contentType}`);

      if (details.truncated) {
        text += theme.fg("warning", " (truncated)");
      }

      if (expanded) {
        const content =
          result.content[0]?.type === "text" ? result.content[0].text : "";
        const lines = content.split("\n").slice(0, 30);
        for (const line of lines) {
          text += `\n${theme.fg("dim", line)}`;
        }
        if (content.split("\n").length > 30) {
          text += `\n${theme.fg("muted", "...")}`;
        }
        if (details.fullOutputPath) {
          text += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
        }
      }

      return new Text(text, 0, 0);
    },
  });
}
