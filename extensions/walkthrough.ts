import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const NodeSchema = Type.Object({
  id: Type.String({ description: "Stable node id used in the diagram" }),
  label: Type.String({ description: "Human-readable node label" }),
  detail: Type.String({ description: "Explanation of this node" }),
  file: Type.Optional(Type.String({ description: "Related source file path" })),
  line: Type.Optional(
    Type.Number({ description: "Related 1-indexed source line" }),
  ),
});

const walkthroughTool = defineTool({
  name: "create_walkthrough",
  label: "Create Walkthrough",
  description:
    "Create a shareable merm.sh Mermaid diagram walkthrough and save a local companion file.",
  promptSnippet:
    "Create shareable merm.sh Mermaid walkthrough diagrams for code flows, schemas, dependencies, and architecture.",
  promptGuidelines: [
    "Use create_walkthrough when the user asks for a walkthrough, diagram, flowchart, ER diagram, dependency graph, or shareable visual explanation.",
    "For create_walkthrough, inspect the relevant code first, then provide valid Mermaid source with concise labels and enough node details for a useful companion walkthrough.",
  ],
  parameters: Type.Object({
    title: Type.String({ description: "Walkthrough title" }),
    diagramType: StringEnum(
      [
        "flowchart",
        "er",
        "sequence",
        "mindmap",
        "class",
        "state",
        "timeline",
      ] as const,
      {
        description: "Kind of Mermaid diagram being created",
      },
    ),
    mermaid: Type.String({ description: "Complete, valid Mermaid source" }),
    summary: Type.Optional(
      Type.String({
        description: "Short explanation of what the walkthrough shows",
      }),
    ),
    nodes: Type.Optional(
      Type.Array(NodeSchema, {
        description: "Important nodes with drill-down context",
      }),
    ),
  }),

  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    const mermaid = params.mermaid.trim();
    if (!mermaid) {
      return {
        isError: true,
        content: [{ type: "text", text: "No Mermaid source provided." }],
      };
    }

    const response = await fetch("https://merm.sh/api/d", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ title: params.title, content: mermaid }),
      signal,
    });

    const bodyText = await response.text();
    if (!response.ok) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `merm.sh returned ${response.status}: ${bodyText}`,
          },
        ],
        details: { status: response.status, response: bodyText },
      };
    }

    let result: {
      url?: string;
      editUrl?: string;
      secret?: string;
      id?: string;
      editId?: string;
      version?: number;
    };
    try {
      result = JSON.parse(bodyText);
    } catch {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `merm.sh returned non-JSON response: ${bodyText}`,
          },
        ],
        details: { response: bodyText },
      };
    }

    if (!result.url) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `merm.sh response did not include a share URL: ${bodyText}`,
          },
        ],
        details: result,
      };
    }

    const dir = path.join(ctx.cwd, ".pi", "walkthroughs");
    await mkdir(dir, { recursive: true });

    const slug = slugify(params.title);
    const base = path.join(dir, slug);
    const markdownPath = `${base}.md`;
    const jsonPath = `${base}.json`;
    const saved = {
      ...params,
      merm: result,
      createdAt: new Date().toISOString(),
    };

    await writeFile(jsonPath, JSON.stringify(saved, null, 2), "utf8");
    await writeFile(markdownPath, renderMarkdown(params, result.url), "utf8");

    return {
      content: [
        {
          type: "text",
          text: `[View walkthrough](${result.url})\n\nSaved local companion files:\n- ${path.relative(ctx.cwd, markdownPath)}\n- ${path.relative(ctx.cwd, jsonPath)}`,
        },
      ],
      details: { ...result, markdownPath, jsonPath },
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(walkthroughTool);

  pi.registerCommand("walkthrough", {
    description: "Create a shareable merm.sh walkthrough for a topic",
    handler: async (args, ctx) => {
      const topic = args.trim();
      if (!topic) {
        ctx.ui.notify("Usage: /walkthrough <topic to explain>", "info");
        return;
      }

      pi.sendUserMessage(
        `Create a walkthrough for: ${topic}\n\nInspect the relevant code first. Then call create_walkthrough with valid Mermaid, a concise summary, and useful node details with source file references when available.`,
      );
    },
  });
}

function slugify(value: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "walkthrough";
}

function renderMarkdown(
  params: {
    title: string;
    diagramType: string;
    mermaid: string;
    summary?: string;
    nodes?: Array<{
      id: string;
      label: string;
      detail: string;
      file?: string;
      line?: number;
    }>;
  },
  url: string,
) {
  const lines = [`# ${params.title}`, "", `[View hosted diagram](${url})`, ""];

  if (params.summary) lines.push("## Summary", "", params.summary, "");

  lines.push("## Mermaid", "", "```mermaid", params.mermaid, "```", "");

  if (params.nodes?.length) {
    lines.push("## Nodes", "");
    for (const node of params.nodes) {
      lines.push(`### ${node.label}`, "", `ID: \`${node.id}\``);
      if (node.file)
        lines.push(
          `Source: \`${node.file}${node.line ? `:${node.line}` : ""}\``,
        );
      lines.push("", node.detail, "");
    }
  }

  return `${lines.join("\n").trim()}\n`;
}
