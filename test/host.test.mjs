/**
 * Host-half regression tests.
 *
 * Covers the two defects behind "agent/request proposed X after step
 * preparation fixed Y" and the follow-up "it only works after the parent
 * sends another message":
 *
 * 1. The plugin must not change provider/model inside `agent/request`; DSH
 *    freezes the step's selection before that waterfall and rejects the
 *    change, failing the child's first turn.
 * 2. A cold-resumed child arrives with fresh AgentOptions that omit
 *    `subagentDepth`, so subagent detection must use the durable Session
 *    header instead of runtime options.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, createSelectionApplier } from '../lib/index.js'

const ROUTE = { provider: 'opencode-go-completions', model: 'hy4-flash-free' }

/** Minimal Cordis-shaped context: records listeners and exposes fake services. */
function createFakeContext(services = {}) {
  const handlers = new Map()
  const provided = new Map()
  const ctx = {
    fiber: { entry: { options: { id: 'subagent-model-picker' } } },
    reflect: {
      props: {},
      provide(name, instance) {
        provided.set(name, instance)
      },
    },
    get(key) {
      return services[key]
    },
    on(event, listener) {
      const list = handlers.get(event)
      if (list === undefined) handlers.set(event, [listener])
      else list.push(listener)
      return () => {}
    },
    inject() {},
    effect() {},
  }
  return { ctx, handlers, provided }
}

/** Fake config object: the loader hands the plugin an already-parsed Config. */
function fakeConfig(selections) {
  return { selections: { get: () => selections } }
}

/** Fake live agent. */
function fakeAgent({ id, header, options = {}, modelCalls = [] }) {
  return {
    id,
    options,
    session: { header },
    model: {
      select(selection) {
        modelCalls.push(selection)
      },
    },
    modelCalls,
  }
}

/** Fake Session node, as the `sessions` service returns it. */
function fakeSession({ id, header }) {
  return { id, header }
}

function rootHeader(id) {
  return { id, cwd: '/tmp' }
}

function childHeader(id, parentSession, delegationDepth) {
  return { id, parentSession, origin: 'subagent', delegationDepth }
}

test('does not listen on the deprecated agent/request waterfall', () => {
  const { ctx, handlers } = createFakeContext()
  apply(ctx, fakeConfig({}))
  assert.equal(handlers.has('agent/request'), false)
  assert.equal(handlers.has('agent/created'), true)
})

test('selects the route on a fresh child before step preparation', () => {
  const root = fakeAgent({ id: 'root', header: rootHeader('root') })
  const agents = new Map([[root.id, root]])
  const { ctx } = createFakeContext({ agents })
  const applier = createSelectionApplier(ctx, {
    get: id => (id === 'root' ? { ...ROUTE, reasoningEffort: 'max' } : null),
  })

  const child = fakeAgent({
    id: 'child',
    header: childHeader('child', 'root', 1),
    options: { provider: 'codex', model: 'gpt-6-luna', subagentDepth: 1 },
  })
  applier(child)

  assert.deepEqual(child.modelCalls, [{ ...ROUTE, reasoningEffort: 'max' }])
})

test('selects the route on a cold-resumed child that lost subagentDepth', () => {
  // Regression: resume rebuilds options from the descriptor and omits depth,
  // which used to make the plugin stop recognising the child at all.
  const root = fakeAgent({ id: 'root', header: rootHeader('root') })
  const agents = new Map([[root.id, root]])
  const { ctx } = createFakeContext({ agents })
  const applier = createSelectionApplier(ctx, {
    get: id => (id === 'root' ? { ...ROUTE } : null),
  })

  const resumed = fakeAgent({
    id: 'child',
    header: childHeader('child', 'root', 1),
    options: { provider: 'codex', model: 'gpt-6-luna', reasoningEffort: 'max' },
  })
  applier(resumed)

  assert.deepEqual(resumed.modelCalls, [ROUTE])
})

test('leaves the main agent untouched', () => {
  const root = fakeAgent({ id: 'root', header: rootHeader('root') })
  const agents = new Map([[root.id, root]])
  const { ctx } = createFakeContext({ agents })
  const applier = createSelectionApplier(ctx, { get: () => ROUTE })
  applier(root)
  assert.deepEqual(root.modelCalls, [])
})

test('inherits when the root session has no selection', () => {
  const root = fakeAgent({ id: 'root', header: rootHeader('root') })
  const agents = new Map([[root.id, root]])
  const { ctx } = createFakeContext({ agents })
  const applier = createSelectionApplier(ctx, { get: () => null })
  const child = fakeAgent({
    id: 'child',
    header: childHeader('child', 'root', 1),
    options: { subagentDepth: 1 },
  })
  applier(child)
  assert.deepEqual(child.modelCalls, [])
})

test('walks nested descendants up to the root session', () => {
  const root = fakeAgent({ id: 'root', header: rootHeader('root') })
  const mid = fakeAgent({
    id: 'mid',
    header: childHeader('mid', 'root', 1),
    options: { subagentDepth: 1 },
  })
  const agents = new Map([
    [root.id, root],
    [mid.id, mid],
  ])
  const { ctx } = createFakeContext({ agents })
  const applier = createSelectionApplier(ctx, {
    get: id => (id === 'root' ? { ...ROUTE } : null),
  })

  const leaf = fakeAgent({
    id: 'leaf',
    header: childHeader('leaf', 'mid', 2),
    options: { subagentDepth: 2 },
  })
  applier(leaf)
  assert.deepEqual(leaf.modelCalls, [ROUTE])
})

test('walks through a live Session when the parent Agent was released', () => {
  const rootSession = fakeSession({ id: 'root', header: { ...rootHeader('root'), origin: 'user' } })
  const sessions = new Map([[rootSession.id, rootSession]])
  const { ctx } = createFakeContext({ sessions })
  const applier = createSelectionApplier(ctx, {
    get: id => (id === 'root' ? { ...ROUTE } : null),
  })

  const child = fakeAgent({
    id: 'child',
    header: childHeader('child', 'root', 1),
    options: {},
  })
  applier(child)
  assert.deepEqual(child.modelCalls, [ROUTE])
})

test('re-applies the current pick when a resident child receives a message', () => {
  const root = fakeAgent({ id: 'root', header: rootHeader('root') })
  const agents = new Map([[root.id, root]])
  const { ctx, handlers } = createFakeContext({ agents })
  apply(ctx, fakeConfig({ root: { ...ROUTE } }))

  const child = fakeAgent({
    id: 'child',
    header: childHeader('child', 'root', 1),
    options: {},
  })
  for (const listener of handlers.get('agent/inbox/inserted')) {
    listener({ agent: child })
  }
  assert.deepEqual(child.modelCalls, [ROUTE])
})

test('the Remote service resolves a child session id to the root selection', async () => {
  const root = fakeAgent({ id: 'root', header: rootHeader('root') })
  const child = fakeAgent({
    id: 'child',
    header: childHeader('child', 'root', 1),
    options: {},
  })
  const agents = new Map([
    [root.id, root],
    [child.id, child],
  ])
  const { ctx, provided } = createFakeContext({ agents })
  apply(ctx, fakeConfig({ root: { ...ROUTE, reasoningEffort: 'max' } }))

  const service = provided.get('subagent-model-picker')
  assert.equal(typeof service?.get, 'function')
  assert.deepEqual(service.get('child'), { ...ROUTE, reasoningEffort: 'max' })
  assert.deepEqual(service.get('root'), { ...ROUTE, reasoningEffort: 'max' })
  assert.equal(service.get('cold-session'), null)
})
