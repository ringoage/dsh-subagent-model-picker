/**
 * dsh-subagent-model-picker (client half)
 *
 * Registers a compact selector into `conversation.input.right`, which the
 * composer InputBar renders immediately to the LEFT of the main model seat
 * (`conversation.input.model`). The selection is PER-SESSION: the selector
 * reads/writes this session's entry of the `subagent-model-picker` map through the
 * package's Typert Remote service (`remote.subagent-model-picker`), so switching
 * sessions shows each session's own choice.
 *
 * The dropdown mirrors the main model seat: a two-level menu (Model / Effort)
 * so a model with reasoning metadata also exposes its reasoning-effort levels
 * ("off"/"high"/"max"/… depending on the provider). UI copy is localised
 * through the shell locale service (`zh` / `en`), and the dropdown closes when
 * the user clicks anywhere outside the selector or presses Escape.
 */
window.__ModuleLoader__.load({
  id: "dsh-subagent-model-picker",
  factory: (require) => {
    const React = require("react");

    const inject = ["slots", "connection", "remote", "locale"];
    const name = "dsh-subagent-model-picker";
    const LOCALE_NS = "subagent-model-picker";

    // ---- Remote contribution (hand-written strict descriptors) ----------
    // `zod` is not a platform seed word, so these schemas carry a minimal
    // `parse` contract — the client gateway only requires `codec.mode ===
    // "strict"` and a callable `schema.parse`.
    function makeSchema(validate) {
      return {
        parse(value) {
          if (!validate(value)) throw new Error("subagent-model-picker: invalid value");
          return value;
        },
      };
    }

    const stringSchema = makeSchema((v) => typeof v === "string");
    const selectionSchema = makeSchema(
      (v) =>
        v === null ||
        (typeof v === "object" &&
          v !== null &&
          typeof v.provider === "string" &&
          typeof v.model === "string" &&
          (v.reasoningEffort === undefined ||
            typeof v.reasoningEffort === "string"))
    );

    function descriptor(method, parameters) {
      return {
        id: "dsh-subagent-model-picker#subagent-model-picker/" + method,
        service: "subagent-model-picker",
        namespace: "subagent-model-picker",
        method,
        invocation: { kind: "direct" },
        parameters,
        result: {
          mode: "strict",
          typeSymbol: "dsh-subagent-model-picker/types#Selection",
          schema: selectionSchema,
        },
      };
    }

    function jsonParameter(wire) {
      return {
        name: wire,
        wire,
        source: "json",
        codec: {
          mode: "strict",
          typeSymbol: "dsh-subagent-model-picker/types#SessionId",
          schema: stringSchema,
        },
      };
    }

    const CONTRIBUTION = {
      package: "dsh-subagent-model-picker",
      descriptors: [
        descriptor("get", [jsonParameter("sessionId")]),
        descriptor("set", [
          jsonParameter("sessionId"),
          {
            name: "selection",
            wire: "selection",
            source: "json",
            codec: {
              mode: "strict",
              typeSymbol: "dsh-subagent-model-picker/types#Selection",
              schema: selectionSchema,
            },
          },
        ]),
        descriptor("clear", [jsonParameter("sessionId")]),
      ],
    };

    // ---- Locale dictionaries -------------------------------------------
    const ZH_DICT = {
      "trigger.label": "子代理模型",
      "option.inherit": "继承主模型（默认）",
      "menu.model": "模型",
      "menu.effort": "思考程度",
      "effort.providerDefault": "默认",
    };
    const EN_DICT = {
      "trigger.label": "Subagent Model",
      "option.inherit": "Inherit main model (default)",
      "menu.model": "Model",
      "menu.effort": "Thinking effort",
      "effort.providerDefault": "Default",
    };

    // ---- Styles (mirrors the main model seat: transparent by default, a
    // ---- translucent pill on hover) ------------------------------------
    const CSS_ID = "dsh-subagent-model-picker/style";
    const CSS =
      ".dsm-trigger{display:inline-flex;align-items:center;gap:4px;height:28px;" +
      "padding:0 4px 0 8px;border-radius:24px;font-size:13px;font-weight:500;line-height:20px;" +
      "color:var(--dsw-alias-label-secondary,#888);background:transparent;border:none;outline:none;cursor:pointer}" +
      ".dsm-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}" +
      ".dsm-label{max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".dsm-effort{max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" +
      "color:var(--dsw-alias-label-tertiary,#777);font-weight:400}" +
      ".dsm-chevron{font-size:10px;flex:none}" +
      ".dsm-menu{position:absolute;bottom:calc(100% + 8px);right:0;z-index:30;min-width:240px;" +
      "max-height:340px;overflow-y:auto;background:var(--dsw-specific-menu,#1e1e1e);" +
      "border:1px solid var(--dsw-alias-border-inverted,#333);border-radius:12px;padding:4px;" +
      "display:flex;flex-direction:column}" +
      ".dsm-cell{display:flex;align-items:center;gap:8px;width:100%;text-align:left;" +
      "padding:8px;border-radius:8px;border:none;background:transparent;cursor:pointer;" +
      "color:var(--dsw-alias-label-primary,#eee);font-size:13px}" +
      ".dsm-cell:hover{background:var(--dsw-alias-interactive-bg-hover)}" +
      ".dsm-cellLabel{flex:none;font-weight:500}" +
      ".dsm-cellValue{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" +
      "color:var(--dsw-alias-label-secondary,#aaa);text-align:right}" +
      ".dsm-cellChevron{flex:none;color:var(--dsw-alias-label-tertiary,#777);font-size:12px}" +
      ".dsm-option{display:block;width:100%;text-align:left;padding:6px 8px;border-radius:8px;" +
      "border:none;background:transparent;color:var(--dsw-alias-label-primary,#eee);cursor:pointer;" +
      "font-size:13px}" +
      ".dsm-option:hover{background:var(--dsw-alias-interactive-bg-hover)}" +
      ".dsm-optionCopy{display:flex;flex-direction:column;gap:2px;min-width:0}" +
      ".dsm-desc{color:var(--dsw-alias-label-tertiary,#888);font-size:12px;line-height:18px}";
    if (
      typeof document !== "undefined" &&
      document.querySelector(
        "style[data-plugin-css=" + JSON.stringify(CSS_ID) + "]"
      ) === null
    ) {
      const tag = document.createElement("style");
      tag.dataset.plugin = name;
      tag.dataset.pluginCss = CSS_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    function optionStyle(selected) {
      return {
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "6px 8px",
        borderRadius: "8px",
        border: "none",
        background: selected
          ? "var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.08))"
          : "transparent",
        color: "var(--dsw-alias-label-primary, #eee)",
        cursor: "pointer",
        fontSize: "13px",
      };
    }

    function findModel(groups, provider, model) {
      for (const group of groups) {
        if (group.id !== provider) continue;
        const found = (group.models || []).find((m) => m.id === model);
        if (found) return found;
      }
      return undefined;
    }

    function SubagentModelSelect(props) {
      const api = props.api;
      const sessionId = props.sessionId;
      const remote = props.remote;
      const t = props.t;
      const [state, setState] = React.useState({
        groups: [],
        current: null,
        loading: false,
        open: false,
        pane: "root",
      });
      const rootRef = React.useRef(null);

      React.useEffect(() => {
        let live = true;
        (async () => {
          const groups = await loadGroups(api);
          const current = await loadCurrent(remote, sessionId);
          if (live) setState((s) => ({ ...s, groups, current }));
        })().catch(() => {});
        return () => {
          live = false;
        };
      }, [api, remote, sessionId]);

      // Close the dropdown when the user clicks anywhere outside the selector.
      React.useEffect(() => {
        if (!state.open) return;
        const closeOutside = (event) => {
          if (!rootRef.current || !rootRef.current.contains(event.target)) {
            setState((s) => ({ ...s, open: false }));
          }
        };
        document.addEventListener("mousedown", closeOutside);
        return () => document.removeEventListener("mousedown", closeOutside);
      }, [state.open]);

      async function write(selection) {
        setState((s) => ({ ...s, loading: true }));
        try {
          const res =
            selection === null
              ? await remote.clear(sessionId)
              : await remote.set(sessionId, selection);
          if (!res || !res.ok) {
            throw new Error(
              (res && res.error && res.error.message) || "write failed"
            );
          }
          setState((s) => ({
            ...s,
            current: selection,
            loading: false,
            open: false,
            pane: "root",
          }));
        } catch (error) {
          setState((s) => ({ ...s, loading: false, open: false }));
        }
      }

      function choose(selection) {
        return write(selection);
      }

      function chooseEffort(effort) {
        if (state.current === null) return;
        return write({
          provider: state.current.provider,
          model: state.current.model,
          ...(effort === undefined ? {} : { reasoningEffort: effort }),
        });
      }

      const options = [];
      for (const group of state.groups) {
        for (const model of group.models) {
          options.push({
            provider: group.id,
            model: model.id,
            label: (group.name || group.id) + " · " + (model.name || model.id),
          });
        }
      }

      const currentModel = state.current
        ? findModel(state.groups, state.current.provider, state.current.model)
        : undefined;
      const reasoning = currentModel ? currentModel.reasoning : undefined;
      const effectiveEffort =
        state.current && state.current.reasoningEffort !== undefined
          ? state.current.reasoningEffort
          : reasoning
            ? reasoning.defaultEffort
            : undefined;
      const effortLabel =
        reasoning === undefined
          ? undefined
          : effectiveEffort === undefined
            ? t("effort.providerDefault")
            : (reasoning.efforts.find((e) => e.id === effectiveEffort) || {})
                .name || effectiveEffort;
      const effortChoices =
        reasoning === undefined
          ? []
          : [
              ...(reasoning.defaultEffort === undefined
                ? [
                    {
                      key: "provider-default",
                      effort: undefined,
                      label: t("effort.providerDefault"),
                    },
                  ]
                : []),
              ...reasoning.efforts.map((e) => ({
                key: "effort:" + e.id,
                effort: e.id,
                label: e.name,
                description: e.description,
              })),
            ];

      const matched = state.current
        ? options.find(
            (o) =>
              o.provider === state.current.provider &&
              o.model === state.current.model
          )
        : undefined;
      const modelLabel = state.current
        ? matched
          ? matched.label
          : state.current.provider + " / " + state.current.model
        : t("trigger.label");

      const toggle = () => {
        if (state.open) {
          setState((s) => ({ ...s, open: false }));
        } else {
          setState((s) => ({ ...s, open: true, pane: "root" }));
        }
      };
      const onKeyDown = (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        if (state.pane !== "root") setState((s) => ({ ...s, pane: "root" }));
        else setState((s) => ({ ...s, open: false }));
      };

      return React.createElement(
        "div",
        {
          ref: rootRef,
          onKeyDown,
          style: { position: "relative", display: "inline-flex" },
        },
        React.createElement(
          "button",
          {
            type: "button",
            className: "dsm-trigger",
            onClick: toggle,
            title: modelLabel,
            "aria-haspopup": "menu",
            "aria-expanded": state.open,
          },
          React.createElement("span", { className: "dsm-label" }, modelLabel),
          effortLabel !== undefined &&
            state.current !== null &&
            React.createElement("span", { className: "dsm-effort" }, effortLabel),
          React.createElement(
            "span",
            { className: "dsm-chevron" },
            state.open ? "▲" : "▼"
          )
        ),
        state.open &&
          React.createElement(
            "div",
            { role: "menu", className: "dsm-menu" },
            state.pane === "root" &&
              React.createElement(
                React.Fragment,
                null,
                React.createElement(
                  "button",
                  {
                    type: "button",
                    role: "menuitem",
                    className: "dsm-cell",
                    onClick: () =>
                      setState((s) => ({ ...s, pane: "model" })),
                  },
                  React.createElement(
                    "span",
                    { className: "dsm-cellLabel" },
                    t("menu.model")
                  ),
                  React.createElement(
                    "span",
                    { className: "dsm-cellValue" },
                    modelLabel
                  ),
                  React.createElement(
                    "span",
                    { className: "dsm-cellChevron" },
                    "›"
                  )
                ),
                reasoning !== undefined &&
                  React.createElement(
                    "button",
                    {
                      type: "button",
                      role: "menuitem",
                      className: "dsm-cell",
                      onClick: () =>
                        setState((s) => ({ ...s, pane: "effort" })),
                    },
                    React.createElement(
                      "span",
                      { className: "dsm-cellLabel" },
                      t("menu.effort")
                    ),
                    React.createElement(
                      "span",
                      { className: "dsm-cellValue" },
                      effortLabel
                    ),
                    React.createElement(
                      "span",
                      { className: "dsm-cellChevron" },
                      "›"
                    )
                  )
              ),
            state.pane === "model" &&
              React.createElement(
                React.Fragment,
                null,
                React.createElement(
                  "button",
                  {
                    type: "button",
                    role: "menuitemradio",
                    "aria-checked": state.current === null,
                    onClick: () => choose(null),
                    disabled: state.loading,
                    style: optionStyle(state.current === null),
                  },
                  t("option.inherit")
                ),
                options.map((option) =>
                  React.createElement(
                    "button",
                    {
                      key: option.provider + "/" + option.model,
                      type: "button",
                      role: "menuitemradio",
                      "aria-checked":
                        state.current !== null &&
                        state.current.provider === option.provider &&
                        state.current.model === option.model,
                      onClick: () =>
                        choose({ provider: option.provider, model: option.model }),
                      disabled: state.loading,
                      style: optionStyle(
                        state.current !== null &&
                          state.current.provider === option.provider &&
                          state.current.model === option.model
                      ),
                    },
                    option.label
                  )
                )
              ),
            state.pane === "effort" &&
              effortChoices.map((level) =>
                React.createElement(
                  "button",
                  {
                    key: level.key,
                    type: "button",
                    role: "menuitemradio",
                    "aria-checked": effectiveEffort === level.effort,
                    onClick: () => chooseEffort(level.effort),
                    disabled: state.loading,
                    style: optionStyle(effectiveEffort === level.effort),
                  },
                  React.createElement(
                    "span",
                    { className: "dsm-optionCopy" },
                    React.createElement("span", null, level.label),
                    level.description !== undefined &&
                      React.createElement(
                        "span",
                        { className: "dsm-desc" },
                        level.description
                      )
                  )
                )
              )
          )
      );
    }

    async function loadGroups(api) {
      const res = await api.llm.models({});
      if (!res || !res.result || !res.result.ok) return [];
      return Array.isArray(res.result.value.groups)
        ? res.result.value.groups
        : [];
    }

    async function loadCurrent(remote, sessionId) {
      const res = await remote.get(sessionId);
      if (res && res.ok) return res.value; // null | { provider, model, reasoningEffort? }
      return null;
    }

    async function apply(ctx) {
      const slots = ctx.slots;
      const connection = ctx.connection;
      const locale = ctx.locale;
      if (slots === undefined || connection === undefined) return;
      const api = connection.api;

      // Register the localised copy for the selector (zh fallback + en).
      ctx.effect(() => {
        const disposers = [];
        try {
          disposers.push(locale.register(LOCALE_NS, "zh", ZH_DICT));
          disposers.push(locale.register(LOCALE_NS, "en", EN_DICT));
        } catch (error) {
          for (const dispose of disposers.reverse()) dispose();
          throw error;
        }
        return () => {
          for (const dispose of disposers) dispose();
        };
      }, "dsh-subagent-model-picker: locale dictionaries");

      // Mount the Remote contribution, then resolve the namespace service.
      const remote = await ctx.remote
        .$mount(CONTRIBUTION)
        .then(() => ctx.get("remote.subagent-model-picker"));

      const t = locale.bind(LOCALE_NS);

      slots.inject("conversation.input.right", () =>
        slots.register(
          {
            name: "conversation.input.right",
            id: "subagent-model-picker",
            order: 0,
            inject: (sessionId) => ({ api, sessionId, remote, t }),
          },
          SubagentModelSelect
        )
      );
    }

    return { apply, inject, name };
  },
});
