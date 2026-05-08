import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ModelProfileName = "fast" | "strong" | "deep";

type ModelProfile = {
  provider: string;
  id: string;
  reasoning: ModelThinkingLevel;
};

const MODEL_PROFILES: Record<ModelProfileName, ModelProfile> = {
  fast: {
    provider: "google",
    id: "gemini-flash-lite-latest",
    reasoning: "low",
  },
  strong: {
    provider: "anthropic",
    id: "claude-sonnet-4-6",
    reasoning: "medium",
  },
  deep: {
    provider: "openai",
    id: "gpt-5.3-codex",
    reasoning: "high",
  },
};

type ModelAuth = {
  apiKey: string;
  headers?: Record<string, string>;
};

export type ResolvedModelProfile = {
  name: ModelProfileName;
  source: "profile" | "active";
  model: Model<Api>;
  auth: ModelAuth;
  options: ModelAuth & { reasoning?: ModelThinkingLevel };
};

export function describeModelProfile(profile: ResolvedModelProfile): string {
  const model = `${profile.model.provider}/${profile.model.id}`;
  return profile.source === "profile"
    ? `${profile.name}: ${model}`
    : `active: ${model}`;
}

export async function getModelProfile(
  ctx: ExtensionContext,
  name: ModelProfileName,
): Promise<ResolvedModelProfile | undefined> {
  const profile = MODEL_PROFILES[name];
  const profileModel = ctx.modelRegistry.find(profile.provider, profile.id);

  if (profileModel) {
    const auth = await getModelAuth(ctx, profileModel);
    if (auth) {
      return {
        name,
        source: "profile",
        model: profileModel,
        auth,
        options: { ...auth, reasoning: profile.reasoning },
      };
    }
  }

  if (!ctx.model) return undefined;

  const auth = await getModelAuth(ctx, ctx.model);
  if (!auth) return undefined;

  return {
    name,
    source: "active",
    model: ctx.model,
    auth,
    options: auth,
  };
}

async function getModelAuth(
  ctx: ExtensionContext,
  model: Model<Api>,
): Promise<ModelAuth | undefined> {
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) return undefined;
  return { apiKey: auth.apiKey, headers: auth.headers };
}
