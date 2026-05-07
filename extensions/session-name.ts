/**
 * auto session naming — generates a short title from the first user message.
 *
 * fires on the `input` event so the name appears while the agent is still
 * thinking. uses the fast model profile for speed/cost. only names the session once.
 */

import { complete, type Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { resolveModel, type ModelResolverContext } from "./lib/model-profiles";

export default function (pi: ExtensionAPI) {
  let named = false;

  pi.on("input", async (event, ctx) => {
    if (named) return;
    if (pi.getSessionName()) {
      named = true;
      return;
    }

    // skip slash commands and very short inputs
    const text = event.text.trim();
    if (text.startsWith("/") || text.length < 10) return;

    named = true;

    // fire and forget — don't block the input pipeline
    generateName({ model: ctx.model, modelRegistry: ctx.modelRegistry }, text)
      .then((name) => {
        if (name) pi.setSessionName(name);
      })
      .catch(() => {});
  });

  pi.on("session_start", async () => {
    named = false;
  });
}

async function generateName(
  ctx: ModelResolverContext,
  userMessage: string,
): Promise<string | null> {
  const resolved = await resolveModel(ctx, "fast");
  if (!resolved.ok) return null;

  const message: Message = {
    role: "user",
    content: [
      {
        type: "text",
        text: `Generate a 3-5 word title for a coding session that starts with this message. Return ONLY the title, no quotes, no punctuation, no explanation. Lowercase.\n\n${userMessage.slice(0, 500)}`,
      },
    ],
    timestamp: Date.now(),
  };

  const response = await complete(
    resolved.model,
    { messages: [message] },
    { apiKey: resolved.apiKey, headers: resolved.headers, maxTokens: 20 },
  );
  if (response.stopReason === "aborted") return null;

  const title = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();

  return title || null;
}
