# dsh-subagent-model-picker

**The visual, manual subagent-model selector for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**

Pick a cheaper / faster model — and its reasoning effort — for every in-process
subagent, right beside the main model seat, per session, with zero guessing.

## Why this exists

"Route subagents to a cheaper model" has been done many ways in the last few
days, but they all decide *for* you:

| Approach | How it picks | Who decides | Predictable? |
| --- | --- | --- | --- |
| Tool-based | a tool the model itself calls | the model | ❌ run-dependent |
| Auto-routing | rules / plan-mode classification | the plugin's policy | ⚠️ only as good as its rules |
| Command-based | a `/command` you type | you, imperatively | ✅ but no visible state |
| **Manual GUI (this)** | **a seat beside the model seat** | **you, visually** | ✅ deterministic + always visible |

`dsh-subagent-model-picker` is the **only visual, manual selector** in this
category: a GUI control next to the main model seat, so the choice is explicit,
visible at a glance, and applies deterministically to **every** subagent path.

## What it gives you

- **Manual** — you choose; not a policy, not the model itself.
- **Visual** — a dropdown beside the main model seat (hover pill + click-outside-to-close + Escape).
- **Predictable** — the selection is per-session state; every child gets exactly what you picked.
- **Global coverage** — one host-side `agent/request` listener covers `subagent`, `subagent_fork`, and workflow fan-out children at any depth.
- **Reasoning effort** — models that expose effort levels (e.g. `off` / `high` / `max`) get a matching "Thinking effort" menu.
- **Inherit by default** — subagents stay on the main model until you opt in.
- **Per-session + durable** — the choice follows the session and survives restart.
- **Localised** — `zh` / `en` UI copy.

## Complementary, not a replacement

Auto-routing plugins (tier/smart/adaptive routers, plan-mode classification)
and tool/command approaches answer *"pick for me"*. This plugin answers
*"let me pick"*. They compose: keep an auto-router as the default policy and use
the picker to override a specific session manually — or the other way around.

## How it works

Two halves cooperate without touching the apiProxy settings whitelist:

1. **Host** (`lib/index.js`) registers one `agent/request` waterfall listener.
   `dsh-scope` admits events *up* the scope chain, so this host-root listener
   sees every agent's requests; a child is recognised by
   `agent.options.subagentDepth >= 1`. It walks the parent chain to the root
   session and overrides `{ provider, model, reasoningEffort? }` only for
   subagents.

2. **Persistence + transport** go through a **Typert Remote service**
   (`subagent-model-picker`, wire namespace `subagent-model-picker`) exposing
   `get` / `set` / `clear`. The client half mounts the Remote contribution
   (`ctx.remote.$mount`) and calls `remote.subagent-model-picker.*`; the service
   persists the `sessionId -> { provider, model, reasoningEffort? }` map
   host-side, so the apiProxy `exposedNamespaces()` whitelist is never consulted.

## Install

### One-liner (GitHub, market-compatible)

```sh
dsh plugin --profile web add github:ringoage/dsh-subagent-model-picker
```

This is the same `github:` install path the DSH plugin market uses, so it can be
installed straight from this repository.

### Manual (edit the profile)

In your web profile (`.dsh/profiles/web/package.json`), add the package as a
dependency and list it in `dsh.profile.bundles`:

```json
{
  "dependencies": {
    "dsh-subagent-model-picker": "^1.0.0"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-subagent-model-picker"]
    }
  }
}
```

Then restart the harness. For a local checkout use a `link:` dependency pointing
at this directory.

## Usage

To the left of the main model selector you will see **Subagent Model**
(or **子代理模型**). Pick a model — and, if offered, a **Thinking effort** — and
every subagent spawned from that session uses it. Choose **Inherit main model
(default)** to restore default routing.

## Limitations

- Only **in-process subagents** are routed: `subagent`, `subagent_fork`, and
  workflow fan-out children driven by DSH itself. External CLI agents
  (e.g. `claude-code`, `codex`) manage their own model selection and are not
  affected.
- The selector is a **web client** feature; host routing works regardless of
  whether the web GUI is open, but the selection itself is edited from the web
  composer.

## Development

- `lib/index.js` — host half (Remote service + `agent/request` routing).
- `lib/client.js` — client half (slot UI + Remote contribution + locale).
- `cordis.patch.yml` — the `dsh.bundle.patch` insert that mounts the plugin row.

The Remote service runs in **SRC mode**: methods are marked with the
`@Remote(name)` contract applied in plain JS (no generated `typert.host.js`),
and the client contribution ships hand-written strict descriptors.

## License

[MIT](./LICENSE)
