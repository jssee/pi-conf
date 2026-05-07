import type { Api, Model } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export type ModelProfile = "fast" | "smart" | "deep";

export type ModelResolverContext = Pick<ExtensionContext, "model" | "modelRegistry">;

type ModelRef = {
  provider: string;
  id: string;
};

export const MODEL_PROFILES: Record<ModelProfile, ModelRef> = {
  fast: { provider: "google", id: "gemini-flash-lite-latest" },
  smart: { provider: "openai", id: "gpt-5.3-codex" },
  deep: { provider: "openai", id: "gpt-5.5" },
};

export type ResolvedModel =
  | {
      ok: true;
      model: Model<Api>;
      apiKey: string;
      headers?: Record<string, string>;
      source: "preferred" | "active";
    }
  | { ok: false; error: string };

async function authenticatedModel(
  ctx: ModelResolverContext,
  model: Model<Api>,
  source: "preferred" | "active",
): Promise<ResolvedModel | undefined> {
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) return undefined;

  return {
    ok: true,
    model,
    apiKey: auth.apiKey,
    headers: auth.headers,
    source,
  };
}

export async function resolveModel(
  ctx: ModelResolverContext,
  profile: ModelProfile,
): Promise<ResolvedModel> {
  const preferred = MODEL_PROFILES[profile];
  const preferredModel = ctx.modelRegistry.find(preferred.provider, preferred.id);
  if (preferredModel) {
    const resolved = await authenticatedModel(ctx, preferredModel, "preferred");
    if (resolved) return resolved;
  }

  if (ctx.model) {
    const resolved = await authenticatedModel(ctx, ctx.model, "active");
    if (resolved) return resolved;
  }

  return {
    ok: false,
    error: `No authenticated model available for ${profile} profile (${preferred.provider}/${preferred.id})`,
  };
}

export function modelCliArg(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}
