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
 * Persistence + transport (approach 2 — no apiProxy settings whitelist):
 * - The per-session selection lives in the `subagent-model-picker` settings
 *   namespace (a `sessionId -> {provider, model, reasoningEffort?}` map),
 *   written ONLY by this host package through the settings service. The
 *   apiProxy `exposedNamespaces()` whitelist is never involved, so the map
 *   survives a dsh upgrade untouched.
 * - A Typert Remote service (`subagent-model-picker`, wire namespace
 *   `subagent-model-picker`) exposes `get` / `set` / `clear` so the client half
 *   reads and writes that map over the standard Remote boundary. It runs in
 *   SRC mode (decorator markers + reflective parameter names) — no generated
 *   `typert.host.js` is shipped or required.
 */
import z from "@deepseek-ai/schemastery";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

const NS = settingsNamespace("subagent-model-picker");
const SCHEMA = z.dict(
  z.object({ provider: z.string(), model: z.string(), reasoningEffort: z.string() })
);

export const name = "dsh-subagent-model-picker";

/** Settings scope, populated once the sibling settings service activates. */
let scope;

class SubagentModelService extends TypertRemoteService {
  constructor(ctx) {
    super(ctx, "subagent-model-picker", { namespace: "subagent-model-picker" });
  }

  /** Read this session's selection, or `null` to inherit the main model. */
  get(sessionId) {
    const rootId = resolveRootSessionId(sessionId, this.ctx.get("agents"));
    return readSelection(rootId);
  }

  /** Store (or, when `selection` is null, clear) this session's selection. */
  async set(sessionId, selection) {
    const rootId = resolveRootSessionId(sessionId, this.ctx.get("agents"));
    return writeSelection(rootId, selection);
  }

  /** Clear this session's selection so it inherits the main model again. */
  async clear(sessionId) {
    const rootId = resolveRootSessionId(sessionId, this.ctx.get("agents"));
    return writeSelection(rootId, null);
  }
}

decorateRemote(SubagentModelService, ["get", "set", "clear"]);

export function apply(ctx) {
  // The settings service is registered by a sibling bundle; `ctx.inject` waits
  // for it (the same pattern `installSettingsSection` uses) rather than racing
  // it with `ctx.get("settings")` at host-boot time.
  ctx.inject(["settings"], (sctx) => {
    try {
      scope = sctx.settings.register(NS, SCHEMA, { base: {} });
    } catch (_) {
      // already registered or invalid — routing falls back to inherit
    }
  });

  // Register the Remote service. `TypertRemoteService`'s constructor calls
  // `super(ctx, name)`, which registers the instance through `reflect.provide`.
  new SubagentModelService(ctx);

  ctx.on("agent/request", async (payload, next) => {
    const config = await next();
    const agent = payload.agent;
    const depth =
      agent && agent.options ? agent.options.subagentDepth : undefined;
    if (typeof depth !== "number" || depth < 1) return config;

    const rootId = findRootSessionId(agent, ctx.get("agents"));
    if (rootId === undefined) return config;

    const selection = readSelection(rootId);
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

/** Read a validated selection for one session id, or `null`. */
function readSelection(sessionId) {
  if (scope === undefined || typeof sessionId !== "string") return null;
  const map = scope.get();
  const value = map && map[sessionId];
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

/** Write (or clear) one session's selection and return the stored value. */
async function writeSelection(sessionId, selection) {
  if (scope === undefined || typeof sessionId !== "string") return null;
  const map = { ...(scope.get() || {}) };
  if (
    selection &&
    typeof selection.provider === "string" &&
    selection.provider !== "" &&
    typeof selection.model === "string" &&
    selection.model !== ""
  ) {
    map[sessionId] = {
      provider: selection.provider,
      model: selection.model,
      ...(typeof selection.reasoningEffort === "string" &&
      selection.reasoningEffort !== ""
        ? { reasoningEffort: selection.reasoningEffort }
        : {}),
    };
  } else {
    delete map[sessionId];
  }
  await scope.replace(map);
  return readSelection(sessionId);
}
