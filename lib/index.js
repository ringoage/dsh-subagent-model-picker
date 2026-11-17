/**
 * dsh-subagent-model-picker (host half)
 *
 * Routes every in-process subagent (one-shot and continuable children, i.e.
 * `subagent`, `subagent_fork`, and their descendants) to a user-selected
 * provider/model while leaving the main agent untouched.
 *
 * Mechanism: `agent/created` (and `agent/inbox/inserted`) listeners call
 * `agent.model.select()` for child agents. `dsh-scope` admits events UP the
 * scope chain, so a host-root listener sees every agent's lifecycle. A child
 * is recognised from its durable Session header (`origin === 'subagent'` or
 * `delegationDepth >= 1`), never only from `AgentOptions.subagentDepth`: a
 * cold resume rebuilds a child's options from its descriptor and deliberately
 * omits the depth, so runtime options cannot identify a resumed child.
 *
 * DSH freezes each step's model selection before the (deprecated)
 * `agent/request` waterfall runs and rejects provider/model/reasoning-effort
 * changes made there with "agent/request proposed … after step preparation
 * fixed …". Selection therefore has to be recorded BEFORE step preparation,
 * which is what `agent.model.select()` does — hence this plugin no longer
 * touches `agent/request`.
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
    const rootId = resolveRootSessionId(sessionId, this.ctx);
    return this.selections.get(rootId);
  }

  /** Store (or, when `selection` is null, clear) this session's selection. */
  async set(sessionId, selection) {
    const rootId = resolveRootSessionId(sessionId, this.ctx);
    return this.selections.set(rootId, selection);
  }

  /** Clear this session's selection so it inherits the main model again. */
  async clear(sessionId) {
    const rootId = resolveRootSessionId(sessionId, this.ctx);
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

  const applyToAgent = createSelectionApplier(ctx, selections);

  // Fires after setup and before any queued work: this covers fresh children
  // and every cold resume, whose AgentOptions arrive without `subagentDepth`.
  ctx.on("agent/created", ({ agent }) => {
    applyToAgent(agent);
  });

  // A resident child can take another turn without being recreated; re-apply
  // the (possibly changed) pick before the loop claims the new message.
  ctx.on("agent/inbox/inserted", ({ agent }) => {
    applyToAgent(agent);
  });
}

/**
 * Build the "record this session's picked route on one child agent" step.
 * Exported so the regression test can drive it without a live Cordis tree.
 * @param ctx - owning host context; reads the `agents` and `sessions` services.
 * @param selections - this profile entry's session-keyed selections.
 * @returns a function that selects the picked route on a child agent, if any.
 */
export function createSelectionApplier(ctx, selections) {
  return (agent) => {
    try {
      applySelection(ctx, selections, agent);
    } catch (error) {
      // A picker failure must never break agent creation or a turn.
      const message = error instanceof Error ? error.message : String(error);
      const logger = ctx.logger;
      if (logger && typeof logger.warn === "function") {
        logger.warn(
          `dsh-subagent-model-picker: could not select the subagent model: ${message}`
        );
      }
    }
  };
}

/** Record the root session's pick on one child agent, if it has one. */
function applySelection(ctx, selections, agent) {
  if (!agent || !agent.model || typeof agent.model.select !== "function") {
    return;
  }
  const header = agent.session && agent.session.header;
  const depth = agent.options && agent.options.subagentDepth;
  const child =
    isSubagentSession(header) || (typeof depth === "number" && depth >= 1);
  if (!child) return;

  const rootId = findRootSessionId(agent, ctx);
  if (rootId === undefined) return;

  const selection = selections.get(rootId);
  if (selection === null) return;

  agent.model.select(toModelSelection(selection));
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

/** Read an Agent's or a Session's durable header. */
function headerOf(node) {
  const session = node && node.session;
  if (session && session.header) return session.header;
  return node ? node.header : undefined;
}

/** Whether one durable Session header marks a subagent child. */
function isSubagentSession(header) {
  if (!header) return false;
  if (header.origin === "subagent") return true;
  return (
    typeof header.delegationDepth === "number" &&
    header.delegationDepth > 0
  );
}

/** Detached `agent.model.select()` payload for one stored selection. */
function toModelSelection(selection) {
  const selected = {
    provider: selection.provider,
    model: selection.model,
  };
  if (
    typeof selection.reasoningEffort === "string" &&
    selection.reasoningEffort !== ""
  ) {
    selected.reasoningEffort = selection.reasoningEffort;
  }
  return selected;
}

/** Walk the live parent chain up to the non-subagent root session id. */
function findRootSessionId(agent, ctx) {
  const agents = ctx.get("agents");
  const sessions = ctx.get("sessions");
  let current = agent;
  const visited = new Set();
  while (current) {
    const id = current.id;
    if (typeof id !== "string" || id === "" || visited.has(id)) {
      return undefined;
    }
    visited.add(id);
    const header = headerOf(current);
    if (header === undefined || !isSubagentSession(header)) return id;
    const parentId = header.parentSession;
    if (typeof parentId !== "string" || parentId === "") return id;
    const parentAgent = agents ? agents.get(parentId) : undefined;
    if (parentAgent !== undefined) {
      current = parentAgent;
      continue;
    }
    const parentSession = sessions ? sessions.get(parentId) : undefined;
    if (parentSession !== undefined) {
      current = parentSession;
      continue;
    }
    // The parent is no longer live: this session is the best root available.
    return id;
  }
  return undefined;
}

/**
 * Resolve the root (non-subagent) session id for any session id. A subagent
 * page passes the child session id here; the walk returns the main session id
 * that owns the selection. Cold sessions that are not in the live registry
 * fall back to their own id (no selection).
 */
function resolveRootSessionId(sessionId, ctx) {
  if (typeof sessionId !== "string" || sessionId === "") return sessionId;
  const agents = ctx.get("agents");
  const sessions = ctx.get("sessions");
  const target =
    (agents ? agents.get(sessionId) : undefined) ||
    (sessions ? sessions.get(sessionId) : undefined);
  if (target === undefined) return sessionId;
  const rootId = findRootSessionId(target, ctx);
  return rootId === undefined ? sessionId : rootId;
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
