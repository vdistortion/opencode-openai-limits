import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { test } from "node:test"
import plugin from "./index.ts"

type Result = { status: string; source: string; primaryPercent: number | null; primaryResetAt: number | null; secondaryResetAt: number | null }
type Handler = (input: unknown, context: { signal: AbortSignal }) => Promise<Result>

async function setup(getCredential: () => object | undefined, fallback = true) {
  let usage: Handler | undefined
  await plugin.setup({
    options: { codexAuthFallback: fallback },
    integration: { connection: {
      active: async () => ({ type: "credential", id: "test" }),
      resolve: async () => getCredential(),
    } },
    rpc: { register: async (_definition: unknown, handlers: { usage: Handler }) => {
      usage = handlers.usage
    } },
  } as unknown as Parameters<typeof plugin.setup>[0])
  assert.ok(usage)
  return () => usage!({}, { signal: new AbortController().signal })
}

test("API key hides usage without fetching or reading Codex auth", async (t) => {
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected fetch") })
  const disk = t.mock.method(fs, "readFile", async () => { throw new Error("Unexpected file read") })
  syncBuiltinESMExports()
  try {
    const usage = await setup(() => ({ type: "key", key: "fake-test-key" }))
    const result = await usage()
    assert.equal(result.status, "hidden")
    assert.equal(result.source, "none")
    assert.equal(network.mock.callCount(), 0)
    assert.equal(disk.mock.callCount(), 0)
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
})

test("switching OAuth to API key bypasses and clears cached usage", async (t) => {
  let credential: object = { type: "oauth", access: "fake-oauth-token" }
  const network = t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    rate_limit: {
      primary_window: { used_percent: 27, reset_at: 1_800_000_000 },
      secondary_window: { used_percent: 5, reset_at: 1_800_500_000 },
    },
  }), { status: 200 }))
  const disk = t.mock.method(fs, "readFile", async () => { throw new Error("Unexpected file read") })
  syncBuiltinESMExports()
  try {
    const usage = await setup(() => credential)
    const initial = await usage()
    assert.equal(initial.status, "ready")
    assert.equal(initial.primaryResetAt, 1_800_000_000)
    assert.equal(initial.secondaryResetAt, 1_800_500_000)
    credential = { type: "key", key: "fake-test-key" }
    assert.equal((await usage()).status, "hidden")
    assert.equal(network.mock.callCount(), 1)
    assert.equal(disk.mock.callCount(), 0)
    credential = { type: "oauth", access: "fake-new-oauth-token" }
    assert.equal((await usage()).status, "ready")
    assert.equal(network.mock.callCount(), 2)
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
})

test("OAuth HTTP 401 retries with Codex when fallback is enabled", async (t) => {
  const network = t.mock.method(globalThis, "fetch", async (_url: unknown, options?: RequestInit) => {
    const authorization = new Headers(options?.headers).get("Authorization")
    if (authorization === "Bearer fake-opencode") return new Response(null, { status: 401 })
    assert.equal(authorization, "Bearer fake-codex")
    return new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 44 } } }))
  })
  const disk = t.mock.method(fs, "readFile", async () => JSON.stringify({
    auth_mode: "chatgpt", tokens: { access_token: "fake-codex", account_id: "fake-account" },
  }))
  syncBuiltinESMExports()
  try {
    const usage = await setup(() => ({ type: "oauth", access: "fake-opencode" }))
    const result = await usage()
    assert.equal(result.status, "ready")
    assert.equal(result.source, "codex")
    assert.equal(result.primaryPercent, 44)
    assert.equal(result.secondaryResetAt, null)
    assert.equal(network.mock.callCount(), 2)
    assert.equal(disk.mock.callCount(), 1)
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
})

test("OAuth HTTP 401 does not read Codex when fallback is disabled", async (t) => {
  const network = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 401 }))
  const disk = t.mock.method(fs, "readFile", async () => { throw new Error("Unexpected file read") })
  syncBuiltinESMExports()
  try {
    const usage = await setup(() => ({ type: "oauth", access: "fake-opencode" }), false)
    const result = await usage()
    assert.equal(result.status, "upstream_error")
    assert.equal(result.source, "opencode")
    assert.equal(network.mock.callCount(), 1)
    assert.equal(disk.mock.callCount(), 0)
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
})

test("OAuth account switch invalidates cached usage, repeated calls reuse it", async (t) => {
  let credential: object | undefined = { type: "oauth", access: "fake-first-account" }
  const network = t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    rate_limit: { primary_window: { used_percent: 10 } },
  })))
  const usage = await setup(() => credential, false)
  assert.equal((await usage()).status, "ready")
  assert.equal((await usage()).status, "ready")
  assert.equal(network.mock.callCount(), 1)
  credential = { type: "oauth", access: "fake-second-account" }
  assert.equal((await usage()).status, "ready")
  assert.equal(network.mock.callCount(), 2)
  credential = undefined
  assert.equal((await usage()).status, "not_connected")
  assert.equal(network.mock.callCount(), 2)
})

test("unexpected successful response is not reported as ready usage", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ unexpected: true })))
  const usage = await setup(() => ({ type: "oauth", access: "fake-access" }), false)
  assert.equal((await usage()).status, "upstream_error")
})

for (const status of [403, 429, 500]) {
  test(`HTTP ${status}: Codex fallback is only used for auth failures`, async (t) => {
    const network = t.mock.method(globalThis, "fetch", async () => new Response(null, { status }))
    const disk = t.mock.method(fs, "readFile", async () => JSON.stringify({
      tokens: { access_token: "fake-codex" },
    }))
    syncBuiltinESMExports()
    try {
      const usage = await setup(() => ({ type: "oauth", access: "fake-access" }))
      const result = await usage()
      assert.equal(result.status, "upstream_error")
      assert.equal(network.mock.callCount(), status === 403 ? 2 : 1)
      assert.equal(disk.mock.callCount(), status === 403 ? 1 : 0)
    } finally {
      t.mock.restoreAll()
      syncBuiltinESMExports()
    }
  })
}

for (const kind of ["missing", "invalid", "expired", "mismatched"] as const) {
  test(`Codex ${kind} auth fails safely without exposing token data`, async (t) => {
    const jwt = (account: string, exp: number) => `header.${Buffer.from(JSON.stringify({
      exp, "https://api.openai.com/auth": { chatgpt_account_id: account },
    })).toString("base64url")}.signature`
    const token = jwt("codex-account", kind === "expired" ? 1 : 4_000_000_000)
    const network = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 401 }))
    const disk = t.mock.method(fs, "readFile", async () => {
      if (kind === "missing") throw new Error("private-file-error-do-not-expose")
      if (kind === "invalid") return "not JSON"
      return JSON.stringify({ tokens: { access_token: token } })
    })
    syncBuiltinESMExports()
    try {
      const usage = await setup(() => ({ type: "oauth", access: jwt("opencode-account", 4_000_000_000) }))
      const result = await usage()
      assert.equal(result.status, kind === "mismatched" ? "unsupported_auth" : "upstream_error")
      assert.equal(network.mock.callCount(), 1)
      assert.equal(disk.mock.callCount(), 1)
      assert.ok(!JSON.stringify(result).includes(token))
      assert.ok(!JSON.stringify(result).includes("private-file-error-do-not-expose"))
    } finally {
      t.mock.restoreAll()
      syncBuiltinESMExports()
    }
  })
}
