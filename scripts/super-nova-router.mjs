// super-nova-router.mjs — Super Nova v2's central model router.
//
// Every LLM call in the agent goes through chatComplete({ role, ... }). The
// router resolves a logical ROLE (planner | executor | critic | researcher) to a
// concrete provider + model, injects the role's persona framing, and performs an
// OpenAI-compatible /chat/completions request.
//
// Pattern source (adapted natively, since these are heavyweight services that
// can't be embedded here): awesome-openrouter (provider routing), ollama / vLLM /
// LocalAI (point a role at a self-hosted OpenAI-compatible endpoint), plus the
// multi-role split from autogen / crewai / agno.
//
// Config — everything is one env change, no code edits:
//   Add a provider:        set its *_BASE_URL + *_API_KEY (openai/openrouter), or
//                          SUPER_NOVA_LOCAL_BASE_URL for a self-hosted endpoint.
//   Point a role elsewhere: SUPER_NOVA_<ROLE>_PROVIDER + SUPER_NOVA_<ROLE>_MODEL
//                          (e.g. SUPER_NOVA_CRITIC_PROVIDER=openai,
//                                SUPER_NOVA_CRITIC_MODEL=gpt-4o-mini).
//   Change the base model:  WORK_TREE_MODEL (default for every role).
//
// If a role's chosen provider isn't configured, the router falls back to bitdeer
// (the always-present default) so a half-set override can never break a run.

// Default model for all roles. gpt-4o-mini is fast and cheap; upgrade to
// gpt-4o for harder tasks. Override per-deployment with WORK_TREE_MODEL env var.
const DEFAULT_MODEL = process.env.WORK_TREE_MODEL || "gpt-4o-mini";

// All providers speak the OpenAI /chat/completions shape. baseURL has no trailing
// slash; key is optional only for `local` (self-hosted servers often need none).
const PROVIDERS = {
  bitdeer: {
    baseURL: process.env.BITDEER_BASE_URL || "https://api-inference.bitdeer.ai/v1",
    key: process.env.BITDEER_API_KEY || "",
  },
  openai: {
    baseURL: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    key: process.env.OPENAI_API_KEY || "",
  },
  openrouter: {
    baseURL: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
    key: process.env.OPENROUTER_API_KEY || "",
  },
  // Generic self-hosted OpenAI-compatible endpoint: Ollama, vLLM, LocalAI, etc.
  // e.g. SUPER_NOVA_LOCAL_BASE_URL=http://127.0.0.1:11434/v1
  local: {
    baseURL: process.env.SUPER_NOVA_LOCAL_BASE_URL || "",
    key: process.env.SUPER_NOVA_LOCAL_API_KEY || "",
  },
};

// The four collaborating roles. Persona is prepended to the system message so the
// role identity is explicit and consistent; temperature is the role default used
// when the caller doesn't pass one.
const ROLE_DEFS = {
  planner: {
    temperature: 0.3,
    persona:
      "You are NOVA's PLANNER. You decompose goals into complete, non-overlapping " +
      "work and synthesize finished results. Think in terms of full coverage and " +
      "clean boundaries; never leave a gap and never duplicate effort.",
  },
  executor: {
    temperature: 0.4,
    persona:
      "You are NOVA's EXECUTOR. You use real tools to produce the actual finished " +
      "deliverable — the work product itself, not a description of how you would " +
      "do it. Never fabricate a fact you could obtain with a tool.",
  },
  critic: {
    temperature: 0,
    persona:
      "You are NOVA's CRITIC, an exacting anti-hallucination gate. Reject anything " +
      "unsupported, fabricated, or short of the stated acceptance criteria. Be " +
      "specific about what must change.",
  },
  researcher: {
    temperature: 0.3,
    persona:
      "You are NOVA's RESEARCHER. You gather facts from real sources, prefer " +
      "primary sources, cross-check claims, and cite the exact URLs you used. " +
      "Distinguish what you verified from what you could not.",
  },
};

export const ROLES = Object.keys(ROLE_DEFS);

function envProvider(role) {
  return (process.env[`SUPER_NOVA_${role.toUpperCase()}_PROVIDER`] || "")
    .trim()
    .toLowerCase();
}

function usable(p, name) {
  return !!(p && p.baseURL && (p.key || name === "local"));
}

// Resolve a role (+ optional caller-supplied model, e.g. the run's chosen model)
// to a concrete { providerName, provider, model, temperature, persona }.
export function resolveRole(role, callerModel) {
  const def = ROLE_DEFS[role] || ROLE_DEFS.executor;
  const overrideProvider = envProvider(role);
  const roleModelEnv = process.env[`SUPER_NOVA_${role.toUpperCase()}_MODEL`];

  // When the role is explicitly pointed at a non-default provider, the caller's
  // model (a bitdeer model id) no longer applies — use the role's configured
  // model. Otherwise prefer the caller's model, then the role env, then default.
  let model = overrideProvider
    ? roleModelEnv || DEFAULT_MODEL
    : callerModel || roleModelEnv || DEFAULT_MODEL;

  // Auto-route gpt-* models to OpenAI; everything else goes to bitdeer.
  let providerName = overrideProvider
    || (model.startsWith("gpt-") ? "openai" : "bitdeer");
  let provider = PROVIDERS[providerName];

  if (!usable(provider, providerName)) {
    if (providerName !== "bitdeer") {
      console.warn(
        `super-nova-router: role '${role}' provider '${providerName}' not configured; falling back to bitdeer`,
      );
      model = callerModel || DEFAULT_MODEL;
    }
    providerName = "bitdeer";
    provider = PROVIDERS.bitdeer;
  }

  return { providerName, provider, model, temperature: def.temperature, persona: def.persona };
}

// Non-mutating persona injection: returns a new messages array with the persona
// merged into (or prepended as) the leading system message. The caller's array
// is never mutated, so it's safe to call on the same array every ReAct step.
function withPersona(persona, messages) {
  if (!persona || !Array.isArray(messages) || !messages.length) return messages;
  const first = messages[0];
  if (first && first.role === "system") {
    return [
      { role: "system", content: `${persona}\n\n${first.content}` },
      ...messages.slice(1),
    ];
  }
  return [{ role: "system", content: persona }, ...messages];
}

// Perform a chat completion for a role. Returns the assistant message content.
export async function chatComplete({
  role = "executor",
  messages,
  model,
  maxTokens = 1500,
  temperature,
  timeoutMs = 120_000,
}) {
  const r = resolveRole(role, model);
  if (!r.provider || !r.provider.baseURL) {
    throw new Error(`router(${role}): no usable provider`);
  }
  if (!r.provider.key && r.providerName !== "local") {
    throw new Error(`router(${role}/${r.providerName}): missing API key`);
  }

  const headers = { "Content-Type": "application/json" };
  if (r.provider.key) headers.Authorization = `Bearer ${r.provider.key}`;
  if (r.providerName === "openrouter") {
    headers["HTTP-Referer"] =
      process.env.OPENROUTER_REFERER || "https://nova-sszi.onrender.com";
    headers["X-Title"] = "Nova Super Nova";
  }

  const body = {
    model: r.model,
    messages: withPersona(r.persona, messages),
    max_tokens: maxTokens,
    temperature: temperature ?? r.temperature,
    stream: false,
  };

  // Fallback chain on 503/429 (overload / rate-limit):
  //   attempt 0   — primary provider + model
  //   attempt 1   — same, after 2 s back-off
  //   attempt 2   — same, after 4 s back-off
  //   attempt 3   — bitdeer + BITDEER_FALLBACK_MODEL (true last resort), 8 s back-off
  // Non-503/429 errors are thrown immediately (no point retrying a 400/401/404).
  const MAX_ATTEMPTS = 4;
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const delayMs = Math.min(2000 * 2 ** (attempt - 1), 8_000);
      await new Promise((ok) => setTimeout(ok, delayMs));

      if (attempt === 3 && r.providerName !== "bitdeer") {
        // Last resort: bitdeer with a known-good model.
        const fallbackModel = process.env.BITDEER_FALLBACK_MODEL || "deepseek-ai/DeepSeek-V3";
        console.warn(
          `router(${role}): primary provider overloaded — falling back to bitdeer/${fallbackModel}`,
        );
        r.providerName = "bitdeer";
        r.provider = PROVIDERS.bitdeer;
        if (!r.provider.key) throw lastErr;
        headers.Authorization = `Bearer ${r.provider.key}`;
        body.model = fallbackModel;
      }
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${r.provider.baseURL}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        const err = new Error(
          `router(${role}/${r.providerName}) HTTP ${res.status}: ${t.slice(0, 300)}`,
        );
        // Only retry on transient overload; hard errors (400/401/404) throw immediately.
        if ((res.status === 503 || res.status === 429) && attempt < MAX_ATTEMPTS - 1) {
          lastErr = err;
          continue;
        }
        throw err;
      }
      const j = await res.json();
      const msg = j.choices?.[0]?.message;
      const content = msg?.content || "";
      if (content) return content;
      // Some reasoning models (Kimi-K2.6, DeepSeek-R1) put the user-facing answer
      // in reasoning_content when content is empty.  Only fall back to it when it
      // appears to contain a complete deliverable — i.e. it has a "final" key
      // (our ReAct protocol) or is long prose, not just a thinking-trace fragment
      // that starts with {"thought":...} and would confuse the ReAct parser.
      const rc = msg?.reasoning_content || "";
      if (rc && (rc.includes('"final"') || (!rc.trimStart().startsWith("{") && rc.length > 50))) {
        return rc;
      }
      return "";
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error(`router(${role}): all attempts exhausted`);
}

// One-line-per-role summary for startup logging (no secrets).
export function routerSummary() {
  return ROLES.map((role) => {
    const r = resolveRole(role);
    return `${role}=${r.providerName}/${r.model}`;
  }).join("  ");
}
