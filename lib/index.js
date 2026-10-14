/**
 * dsh-subagent-model-picker (host half)
 *
 * Routes every in-process subagent (one-shot and continuable children, i.e.
 * `subagent`, `subagent_fork`, and their descendants) to a user-selected
 * provider/model while leaving the main agent untouched.
 *
 * Mechanism: a single `agent/request` waterfall listener. `dsh-scope` admits
 * events UP the scope chain, so this host-root listener sees every agent's
 * requests; a child is recognised by `agent.options.subagentDepth >= 1`
 * (stamped by `resolveChildAgentOptions` for both the one-shot driver and the
 * continuation manager).
 *
 * Persistence + transport (no apiProxy settings whitelist):
 * - The per-session selection lives in this plugin's volatile `selections`
 *   Config field and is persisted through the current DSH Settings service.
 *   The apiProxy `exposedNamespaces()` whitelist is never involved.
 * - A Typert Remote service (`subagent-model-picker`, wire namespace
 *   `subagent-model-picker`) exposes `get` / `set` / `clear` so the client half
 *   reads and writes that map over the standard Remote boundary. It runs in
 *   SRC mode (decorator markers + reflective parameter names) — no generated
 *   `typert.host.js` is shipped or required.
 */

import z from "@deepseek-ai/schemastery";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

const Selection = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string(),
});

export const Config = z.object({
  selections: z.dict(Selection).default({}).volatile(),
});

export const name = "dsh-subagent-model-picker";

/** Owns this profile entry's durable, session-keyed model selections. */
class SessionSelections {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
    this.entryId = ctx.fiber.entry?.options.id;
    this.values = this.readConfig();
    ctx.on("loader/volatile-update", () => {
      this.values = this.readConfig();
    });
  }

  readConfig() {
    const raw = this.config?.selections?.get?.();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return new Map();
    return new Map(
      Object.entries(raw)
        .map(([sessionId, selection]) => [sessionId, normalizeSelection(selection)])
        .filter(([, selection]) => selection !== null)
    );
  }

  get(sessionId) {
    if (typeof sessionId !== "string") return null;
    return this.values.get(sessionId) ?? null;
  }

  async set(sessionId, selection) {
    if (typeof sessionId !== "string") return null;
    const next = new Map(this.values);
    const normalized = normalizeSelection(selection);
    if (normalized) next.set(sessionId, normalized);
    else next.delete(sessionId);

    const settings = this.ctx.get("settings");
    if (settings && this.entryId) {
      // Patch only this session key so simultaneous selections in other
      // sessions cannot overwrite one another.
      await settings.mutate(this.entryId, [
        normalized
          ? { op: "set", path: ["selections", sessionId], value: normalized }
          : { op: "unset", path: ["selections", sessionId] },
      ]);
      this.values = this.readConfig();
    } else this.values = next;
    return this.get(sessionId);
  }
}

class SubagentModelService extends TypertRemoteService {
  constructor(ctx, selections) {
    super(ctx, "subagent-model-picker", { namespace: "subagent-model-picker" });
    this.selections = selections;
  }

  /** Read this session's selection, or `null` to inherit the main model. */
  get(sessionId) {
    const rootId = resolveRootSessionId(sessionId, this.ctx.get("agents"));
    return this.selections.get(rootId);
  }

  /** Store (or, when `selection` is null, clear) this session's selection. */
  async set(sessionId, selection) {
    const rootId = resolveRootSessionId(sessionId, this.ctx.get("agents"));
    return this.selections.set(rootId, selection);
  }

  /** Clear this session's selection so it inherits the main model again. */
  async clear(sessionId) {
    const rootId = resolveRootSessionId(sessionId, this.ctx.get("agents"));
    return this.selections.set(rootId, null);
  }
}

decorateRemote(SubagentModelService, ["get", "set", "clear"]);

export function apply(ctx, config) {
  const selections = new SessionSelections(ctx, config);
  new SubagentModelService(ctx, selections);
  ctx.inject(["settings"], (settingsCtx) => {
    settingsCtx.effect(
      () => settingsCtx.settings.configure({ auto: false }, ctx.fiber),
      "dsh-subagent-model-picker: custom settings UI"
    );
  });

  ctx.on("agent/request", async (payload, next) => {
    const config = await next();
    const agent = payload.agent;
    const depth =
      agent && agent.options ? agent.options.subagentDepth : undefined;
    if (typeof depth !== "number" || depth < 1) return config;

    const rootId = findRootSessionId(agent, ctx.get("agents"));
    if (rootId === undefined) return config;

    const selection = selections.get(rootId);
    if (selection !== null) {
      const overridden = {
        ...config,
        provider: selection.provider,
        model: selection.model,
      };
      if (
        typeof selection.reasoningEffort === "string" &&
        selection.reasoningEffort !== ""
      ) {
        overridden.reasoningEffort = selection.reasoningEffort;
      } else {
        // Drop any inherited effort: it belonged to the previous model and a
        // different model may not support it (UNSUPPORTED_REASONING_EFFORT).
        delete overridden.reasoningEffort;
      }
      return overridden;
    }
    return config;
  });
}

/**
 * Apply the `@Remote(name)` markers to a `TypertRemoteService` subclass in
 * plain JavaScript. The decorator records a private marker on the class
 * prototype; we replay that exact contract without the ES decorator runtime.
 */
function decorateRemote(serviceClass, methodNames) {
  const instance = Object.create(serviceClass.prototype);
  for (const methodName of methodNames) {
    Remote(methodName)(null, {
      name: methodName,
      private: false,
      static: false,
      addInitializer(fn) {
        fn.call(instance);
      },
    });
  }
}

/** Walk the live parent chain up to the non-subagent root session id. */
function findRootSessionId(agent, agents) {
  if (!agents) return undefined;
  let current = agent;
  const visited = new Set();
  while (current) {
    const id = current.id;
    if (id === undefined || visited.has(id)) return undefined;
    visited.add(id);
    const header = current.session && current.session.header;
    if (header && header.origin !== "subagent") return id;
    const parentId = header ? header.parentSession : undefined;
    if (!parentId) return id;
    current = agents.get(parentId);
  }
  return undefined;
}

/**
 * Resolve the root (non-subagent) session id for any session id. A subagent
 * page passes the child session id here; the walk returns the main session id
 * that owns the selection. Cold sessions that are not in the live registry
 * fall back to their own id (no selection).
 */
function resolveRootSessionId(sessionId, agents) {
  if (typeof sessionId !== "string" || !agents) return sessionId;
  let current = agents.get(sessionId);
  const visited = new Set();
  while (current) {
    const id = current.id;
    if (id === undefined || visited.has(id)) return sessionId;
    visited.add(id);
    const header = current.session && current.session.header;
    if (header && header.origin !== "subagent") return id;
    const parentId = header ? header.parentSession : undefined;
    if (!parentId) return id;
    current = agents.get(parentId);
  }
  return sessionId;
}

/** Return a detached selection when its persisted shape is valid. */
function normalizeSelection(value) {
  if (
    value &&
    typeof value.provider === "string" &&
    value.provider !== "" &&
    typeof value.model === "string" &&
    value.model !== ""
  ) {
    return {
      provider: value.provider,
      model: value.model,
      ...(typeof value.reasoningEffort === "string" && value.reasoningEffort !== ""
        ? { reasoningEffort: value.reasoningEffort }
        : {}),
    };
  }
  return null;
}
