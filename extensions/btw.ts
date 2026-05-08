// # btw — Side Conversations for pi
//
// A pi extension that lets you have a separate, parallel conversation
// with the LLM while the main agent is working. Think of it as
// whispering to an assistant without interrupting the one doing the
// actual work.
//
// ## Why?
//
// When pi is in the middle of a long task, you often want to:
// - Ask clarifying questions about what it's doing
// - Think through next steps or plan ahead
// - Get a quick answer without derailing the main session
//
// `/btw` gives you a side channel for all of this. The main agent never
// sees your side conversation — it keeps working undisturbed.
//
// ## Commands
//
// | Command | Description |
// |---------|-------------|
// | `/btw <message>` | Send a message in the side conversation. Streams
// the response in a widget above the editor. Works while the agent is
// running. |
// | `/btw:new [message]` | Start a fresh side thread. Optionally kick
// it off with a message. Clears the previous thread. |
// | `/btw:clear` | Dismiss the widget and clear the current thread. |
// | `/btw:inject [instructions]` | Inject the full btw thread into the
// main agent's context as a user message. Optionally add instructions
// like "implement this plan". Clears the widget after. |
// | `/btw:summarize [instructions]` | Summarize the btw thread via LLM,
// then inject the summary into the main agent's context. Lighter weight
// than full inject. Clears the widget after. |
//
// ## How it works
//
// ### Side conversation
//
// Each `/btw` call builds context from:
// 1. **Main session messages** — the current branch conversation (user
// + assistant messages)
// 2. **Previous btw thread** — all prior btw exchanges in the current
// thread
//
// The btw agent sees everything the main agent has done, plus your
// ongoing side conversation. A system prompt tells it this is an aside
// — it won't try to pick up or continue unfinished work from the main
// session.
//
// The response streams in a bordered widget above the editor using the
// active model and thinking level. Multiple `/btw` calls accumulate in
// the widget, separated by dividers.
//
// ### Continuous threads
//
// The btw thread is continuous by default. Each `/btw` call sees all
// prior btw Q&As, so you can have a multi-turn side conversation. Use
// `/btw:new` to start fresh.
//
// ### Bringing context back
//
// When you've worked something out in the side conversation and want
// the main agent to act on it:
// - `/btw:inject` — sends the full thread verbatim as a user message
// (delivered as a follow-up after the agent finishes)
// - `/btw:summarize` — LLM-summarizes the thread first (using low
// reasoning), then injects the summary
// - Both accept optional instructions: `/btw:inject implement the auth
// plan we discussed`
// - Both clear the widget and reset the thread after injecting
//
// ### Persistence
//
// - Btw entries (question, thinking, answer, model) are persisted in
// the session file via `appendEntry`
// - These are `custom` entries — invisible to the TUI conversation
// thread and the main agent's context
// - Thread reset markers (`btw-reset`) are also persisted, so
// `/btw:clear`, `/btw:new`, `/btw:inject`, and `/btw:summarize` resets
// survive restarts
// - On session restore, the widget reappears with the active thread if
// one exists
// - In-memory thread state (`pendingBtwThread`) tracks completed
// exchanges for continuity between `/btw` calls before they're
// persisted, so rapid-fire btw calls during a single agent run see each
// other's results
//
// ### Widget
//
// - Renders above the editor as a component (no line limit)
// - Bordered box with `╭╰│` left border
// - User messages shown with green `›` prefix
// - Thinking content shown in dim italic with `│` on the first line
// - Answer text shown with `│` on the first line, subsequent lines flow
// freely (terminal handles wrapping)
// - Streaming cursor `▍` shown while thinking or answering
// - Status line shown at bottom of widget during `/btw:summarize`
// - `/btw:clear` to dismiss and reset thread
//
// ## Architecture
//
// ```
// ┌─────────────────────────────────────────────┐
// │ Main pi session                             │
// │  User ↔ Agent (read, bash, edit, write...)  │
// │                                             │
// │  /btw fires a separate streamSimple() call  │
// │  using the same model, thinking level,      │
// │  and conversation context + a system prompt │
// │  that frames it as an aside conversation    │
// │                                             │
// │  btw responses stream into a widget         │
// │  above the editor — never enter the main    │
// │  agent's context                            │
// │                                             │
// │  /btw:inject or /btw:summarize sends the    │
// │  btw thread to the main agent via           │
// │  sendUserMessage (deliverAs: "followUp")    │
// │  then resets the thread                     │
// └─────────────────────────────────────────────┘
// ```
//
// ## Session storage
//
// Btw uses two custom entry types in the session JSONL:
// - `btw` — stores `{ question, thinking, answer, model }` for each
// completed exchange
// - `btw-reset` — stores `{ timestamp }` to mark thread boundaries
//
// These are `custom` entries (not `custom_message`), so they don't
// appear in the TUI conversation or the agent's LLM context.

import {
  streamSimple,
  completeSimple,
  type Message,
} from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

interface BtwDetails {
  question: string;
  thinking: string;
  answer: string;
  model: string;
}

interface BtwSlot {
  question: string;
  model: string;
  thinking: string;
  answer: string;
  done: boolean;
}

const BTW_TYPE = "btw";

const emptyUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * /btw <question>      — Side conversation, streams answer in a widget
 * /btw:new <question>   — Fresh btw thread
 * /btw:clear            — Dismiss the widget
 * /btw:inject [msg]     — Inject full btw thread into main agent context
 * /btw:summarize [msg]  — Summarize btw thread and inject into main agent context
 */
export default function (pi: ExtensionAPI) {
  let btwThreadStart = 0;
  const pendingBtwThread: BtwDetails[] = [];

  // Active widget slots — each /btw call gets one, streams into it
  const slots: BtwSlot[] = [];
  let widgetStatus: string | null = null;

  // ── Restore state from session on reload/restart ─────────────────

  const BTW_RESET_TYPE = "btw-reset";

  pi.on("session_start", async (_event, ctx) => {
    pendingBtwThread.length = 0;
    slots.length = 0;
    btwThreadStart = 0;

    // Find the latest reset marker to know which btw entries are active
    for (const entry of ctx.sessionManager.getBranch()) {
      if (
        entry.type === "custom" &&
        (entry as any).customType === BTW_RESET_TYPE
      ) {
        btwThreadStart = (entry as any).data?.timestamp ?? 0;
      }
    }

    // Reconstruct thread from entries after the last reset
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || (entry as any).customType !== BTW_TYPE)
        continue;
      const entryTime = Date.parse(entry.timestamp) || 0;
      if (entryTime <= btwThreadStart) continue;
      const data = (entry as any).data as BtwDetails | undefined;
      if (data?.question && data?.answer && !data.answer.startsWith("❌")) {
        pendingBtwThread.push(data);
        slots.push({
          question: data.question,
          model: data.model,
          thinking: data.thinking || "",
          answer: data.answer,
          done: true,
        });
      }
    }

    if (slots.length > 0) {
      renderWidget(ctx);
    }
  });

  // ── Widget rendering ─────────────────────────────────────────────

  function renderWidget(ctx: ExtensionContext) {
    if (slots.length === 0) {
      ctx.ui.setWidget("btw", undefined);
      return;
    }

    ctx.ui.setWidget(
      "btw",
      (_tui, theme) => {
        const dim = (s: string) => theme.fg("dim", s);
        const green = (s: string) => theme.fg("success", s);
        const italic = (s: string) => theme.fg("dim", theme.italic(s));
        const yellow = (s: string) => theme.fg("warning", s);

        const parts: string[] = [];

        const title = " 💭 btw ";
        const hint = " /btw:clear to dismiss ";
        const pad = Math.max(0, 50 - title.length - hint.length);
        parts.push(dim(`╭${title}${"─".repeat(pad)}${hint}╮`));

        for (let i = 0; i < slots.length; i++) {
          const s = slots[i];
          if (i > 0) parts.push(dim("│ ───"));
          parts.push(dim("│ ") + green("› ") + s.question);
          if (s.thinking) {
            const cursor = !s.answer && !s.done ? yellow(" ▍") : "";
            parts.push(dim("│ ") + italic(s.thinking) + cursor);
          }
          if (s.answer) {
            const answerLines = s.answer.split("\n");
            parts.push(dim("│ ") + answerLines[0]);
            if (answerLines.length > 1) {
              parts.push(answerLines.slice(1).join("\n"));
            }
            if (!s.done) parts[parts.length - 1] += yellow(" ▍");
          } else if (!s.thinking && !s.done) {
            parts.push(dim("│ ") + yellow("⏳ thinking..."));
          }
        }

        if (widgetStatus) {
          parts.push(dim("│ ") + yellow(widgetStatus));
        }

        parts.push(dim(`╰${"─".repeat(50)}╯`));

        return new Text(parts.join("\n"), 0, 0);
      },
      { placement: "aboveEditor" },
    );
  }

  // ── Helpers ──────────────────────────────────────────────────────

  /** Reset the btw thread — clears state and persists a reset marker */
  function resetThread(ctx: ExtensionContext) {
    btwThreadStart = Date.now();
    pendingBtwThread.length = 0;
    slots.length = 0;
    widgetStatus = null;
    pi.appendEntry(BTW_RESET_TYPE, { timestamp: btwThreadStart });
    renderWidget(ctx);
  }

  /** Collect btw thread — pendingBtwThread is the source of truth
   *  (reconstructed from session on startup, appended live during session) */
  function collectBtwThread(): BtwDetails[] {
    return pendingBtwThread.filter((d) => !d.answer.startsWith("❌"));
  }

  function formatThread(thread: BtwDetails[]): string {
    return thread
      .map((d) => `User: ${d.question.trim()}\nAssistant: ${d.answer.trim()}`)
      .join("\n\n---\n\n");
  }

  function buildMainMessages(ctx: ExtensionContext, model: any): Message[] {
    const messages: Message[] = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const msg = (entry as any).message;
      if (!msg) continue;

      if (msg.role === "user") {
        const content =
          typeof msg.content === "string"
            ? msg.content
            : (msg.content ?? [])
                .filter((c: any) => c.type === "text")
                .map((c: any) => c.text)
                .join("\n");
        if (content) {
          messages.push({
            role: "user",
            content: [{ type: "text", text: content }],
            timestamp: msg.timestamp ?? Date.now(),
          });
        }
      } else if (msg.role === "assistant") {
        const content = (msg.content ?? [])
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n");
        if (content) {
          messages.push({
            role: "assistant",
            content: [{ type: "text", text: content }],
            model: msg.model ?? model.id,
            provider: msg.provider ?? model.provider,
            api: msg.api ?? "",
            usage: msg.usage ?? emptyUsage,
            stopReason: "stop",
            timestamp: msg.timestamp ?? Date.now(),
          });
        }
      }
    }
    return messages;
  }

  function buildBtwMessages(
    ctx: ExtensionContext,
    model: any,
    question: string,
  ): Message[] {
    const mainMessages = buildMainMessages(ctx, model);
    const thread = collectBtwThread();
    const all: Message[] = [...mainMessages];

    if (thread.length > 0) {
      all.push({
        role: "user",
        content: [
          {
            type: "text",
            text: "[The following is a separate side conversation. Continue this thread.]",
          },
        ],
        timestamp: Date.now(),
      });
      all.push({
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Understood, continuing our side conversation.",
          },
        ],
        model: model.id,
        provider: model.provider,
        api: "",
        usage: emptyUsage,
        stopReason: "stop",
        timestamp: Date.now(),
      });
      for (const d of thread) {
        all.push({
          role: "user",
          content: [{ type: "text", text: d.question }],
          timestamp: Date.now(),
        });
        all.push({
          role: "assistant",
          content: [{ type: "text", text: d.answer }],
          model: model.id,
          provider: model.provider,
          api: "",
          usage: emptyUsage,
          stopReason: "stop",
          timestamp: Date.now(),
        });
      }
    }

    all.push({
      role: "user",
      content: [{ type: "text", text: question }],
      timestamp: Date.now(),
    });

    return all;
  }

  function fireBtw(ctx: ExtensionContext, question: string) {
    const model = ctx.model;
    if (!model) {
      ctx.ui.notify("No model selected", "error");
      return;
    }

    const thinkingLevel = pi.getThinkingLevel();
    const modelLabel = `${model.provider}/${model.id}`;
    const allMessages = buildBtwMessages(ctx, model, question);

    // Create a slot for this btw call
    const slot: BtwSlot = {
      question,
      model: modelLabel,
      thinking: "",
      answer: "",
      done: false,
    };
    slots.push(slot);
    renderWidget(ctx);

    (async () => {
      try {
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok || !auth.apiKey) {
          slot.answer = auth.ok ? "❌ No API key" : `❌ ${auth.error}`;
          slot.done = true;
          renderWidget(ctx);
          return;
        }

        const eventStream = streamSimple(
          model,
          {
            systemPrompt:
              "You are having an aside conversation with the user, separate from their main working session. The main session messages are provided for context only — that work is being handled by another agent. Focus on answering the user's side questions, helping them think through ideas, or planning next steps. Do not act as if you need to complete or continue the main session's work.",
            messages: allMessages,
          },
          { apiKey: auth.apiKey, headers: auth.headers, reasoning: thinkingLevel },
        );

        for await (const event of eventStream) {
          if (event.type === "thinking_delta") {
            slot.thinking += event.delta;
            renderWidget(ctx);
          } else if (event.type === "text_delta") {
            slot.answer += event.delta;
            renderWidget(ctx);
          } else if (event.type === "error") {
            slot.answer += `\n❌ ${event.error.message}`;
            slot.done = true;
            renderWidget(ctx);
            return;
          }
        }

        slot.done = true;
        renderWidget(ctx);

        const details = {
          question,
          thinking: slot.thinking,
          answer: slot.answer,
          model: modelLabel,
        } satisfies BtwDetails;
        pendingBtwThread.push(details);

        // Persist in session (hidden from TUI, filtered from agent context)
        pi.appendEntry(BTW_TYPE, details);
      } catch (err: any) {
        slot.answer = `❌ ${err.message}`;
        slot.done = true;
        renderWidget(ctx);
      }
    })();
  }

  // Note: btw entries are stored via appendEntry (custom type, not in LLM context)
  // No context filter needed — custom entries don't participate in LLM context

  // ── Commands ─────────────────────────────────────────────────────

  pi.registerCommand("btw", {
    description:
      "Ask a side question using current context (doesn't affect main session)",
    handler: async (args, ctx) => {
      const question = args.trim();
      if (!question) {
        ctx.ui.notify("Usage: /btw <question>", "warning");
        return;
      }
      fireBtw(ctx, question);
    },
  });

  pi.registerCommand("btw:new", {
    description: "Start a fresh btw thread, optionally with a new question",
    handler: async (args, ctx) => {
      resetThread(ctx);
      const question = args.trim();
      if (question) {
        fireBtw(ctx, question);
      } else {
        ctx.ui.notify("💭 btw: started fresh thread", "info");
      }
    },
  });

  pi.registerCommand("btw:clear", {
    description: "Dismiss the btw widget and clear thread",
    handler: async (_args, ctx) => {
      resetThread(ctx);
    },
  });

  pi.registerCommand("btw:inject", {
    description:
      "Inject btw thread into main agent context [optional instructions]",
    handler: async (args, ctx) => {
      const thread = collectBtwThread();
      if (thread.length === 0 || slots.length === 0) {
        ctx.ui.notify("No active btw thread to inject", "warning");
        return;
      }

      const instructions = args.trim();
      const threadText = formatThread(thread);
      const content = instructions
        ? `Here's a side conversation I had. ${instructions}\n\n<btw-thread>\n${threadText}\n</btw-thread>`
        : `Here's a side conversation I had for additional context:\n\n<btw-thread>\n${threadText}\n</btw-thread>`;

      pi.sendUserMessage(content, { deliverAs: "followUp" });
      resetThread(ctx);
      ctx.ui.notify(
        `💭 btw → main: injected ${thread.length} exchange(s)`,
        "info",
      );
    },
  });

  pi.registerCommand("btw:summarize", {
    description:
      "Summarize btw thread and inject into main agent context [optional instructions]",
    handler: async (args, ctx) => {
      const thread = collectBtwThread();
      if (thread.length === 0 || slots.length === 0) {
        ctx.ui.notify("No active btw thread to summarize", "warning");
        return;
      }

      const model = ctx.model;
      if (!model) {
        ctx.ui.notify("No model selected", "error");
        return;
      }

      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok || !auth.apiKey) {
        ctx.ui.notify(
          auth.ok ? `No API key for ${model.provider}/${model.id}` : auth.error,
          "error",
        );
        return;
      }

      widgetStatus = "⏳ summarizing...";
      renderWidget(ctx);

      try {
        const threadText = formatThread(thread);
        const response = await completeSimple(
          model,
          {
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: [
                      "Summarize this side conversation concisely. Preserve key decisions, plans, insights, and action items.",
                      "Output only the summary, no preamble.",
                      "",
                      "<btw-thread>",
                      threadText,
                      "</btw-thread>",
                    ].join("\n"),
                  },
                ],
                timestamp: Date.now(),
              },
            ],
          },
          { apiKey: auth.apiKey, headers: auth.headers, reasoning: "low" },
        );

        const summary = response.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("\n");

        const instructions = args.trim();
        const content = instructions
          ? `Here's a summary of a side conversation I had. ${instructions}\n\n<btw-summary>\n${summary}\n</btw-summary>`
          : `Here's a summary of a side conversation I had:\n\n<btw-summary>\n${summary}\n</btw-summary>`;

        pi.sendUserMessage(content, { deliverAs: "followUp" });

        resetThread(ctx);
        ctx.ui.notify(
          `💭 btw → main: injected summary of ${thread.length} exchange(s)`,
          "info",
        );
      } catch (err: any) {
        widgetStatus = null;
        renderWidget(ctx);
        ctx.ui.notify(`btw:summarize error — ${err.message}`, "error");
      }
    },
  });
}
