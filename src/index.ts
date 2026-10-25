import { Plugin } from "@opencode/plugin"
import { createHash } from "node:crypto"
import { CodexLimits } from "./rpc.ts"
import { identity, readCodexAuth } from "./codex-auth.ts"

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
const CACHE_MS = 60_000

type UsageWindow = { used_percent?: number; reset_at?: number }
type UsageResponse = {
  rate_limit?: { primary_window?: UsageWindow; secondary_window?: UsageWindow }
}
type UsageResult = {
  status: "ready" | "hidden" | "not_connected" | "unsupported_auth" | "upstream_error"
  message: string
  primaryPercent: number | null
  secondaryPercent: number | null
  primaryResetAt: number | null
  secondaryResetAt: number | null
  source: "opencode" | "codex" | "none"
}

const empty = (
  status: UsageResult["status"],
  message: string,
): UsageResult => ({ status, message, primaryPercent: null, secondaryPercent: null, primaryResetAt: null, secondaryResetAt: null, source: "none" })

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isPercent(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 100
}

export default Plugin.define({
  id: "opencode-openai-limits",
  async setup(ctx) {
    let cached: { credentialHash: string; expiresAt: number; result: UsageResult } | undefined
    let pending: Promise<UsageResult> | undefined

    const loadUsage = async (signal: AbortSignal): Promise<UsageResult> => {
      if (pending) return pending

      pending = (async () => {
        try {
          const connection = await ctx.integration.connection.active("openai")
          const credential = connection ? await ctx.integration.connection.resolve(connection) : undefined
          if (credential?.type === "key") {
            cached = undefined
            return empty("hidden", "")
          }
          const oauth = credential?.type === "oauth" ? credential : undefined
          // Never serve another account's cached limits after a switch or logout.
          // Keep only a fingerprint, not a second copy of the access token, in cache.
          const credentialHash = createHash("sha256").update(JSON.stringify([
            connection, credential?.type, oauth?.access, oauth?.metadata?.accountId,
          ])).digest("hex")
          if (cached?.credentialHash !== credentialHash) cached = undefined
          if (cached && cached.expiresAt > Date.now()) return cached.result
          const request = (access: string, accountId?: unknown) => fetch(USAGE_URL, {
            signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
            redirect: "error",
            headers: {
              Authorization: `Bearer ${access}`,
              "User-Agent": "opencode-openai-limits/0.1.0",
              ...(typeof accountId === "string" ? { "ChatGPT-Account-Id": accountId } : {}),
            },
          })
          let response = oauth?.access ? await request(oauth.access, oauth.metadata?.accountId) : undefined
          let source: UsageResult["source"] = "opencode"
          if (ctx.options.codexAuthFallback === true && (!response || response.status === 401 || response.status === 403)) {
            const codex = await readCodexAuth()
            const currentIdentity = oauth ? identity(oauth.access) : undefined
            const codexIdentity = identity(codex.access)
            if (currentIdentity && codexIdentity && currentIdentity !== codexIdentity) {
              return empty("unsupported_auth", "Codex and OpenCode accounts differ; fallback refused")
            }
            response = await request(codex.access, codex.accountId)
            source = "codex"
          }
          if (!response) return empty("not_connected", "Connect OpenAI OAuth or enable codexAuthFallback")
          if (!response.ok) {
            const result = empty("upstream_error", source === "codex"
              ? `Codex fallback returned HTTP ${response.status}; check your Codex login`
              : `ChatGPT usage endpoint returned HTTP ${response.status}${ctx.options.codexAuthFallback === true ? "" : "; Codex fallback is disabled"}`)
            result.source = source
            return result
          }

          const data = (await response.json()) as UsageResponse
          const primary = data.rate_limit?.primary_window
          const secondary = data.rate_limit?.secondary_window
          if (!isPercent(primary?.used_percent) && !isPercent(secondary?.used_percent)) {
            const result = empty("upstream_error", "ChatGPT returned an unrecognized usage response")
            result.source = source
            return result
          }
          const result: UsageResult = {
            status: "ready",
            source,
            message: "",
            primaryPercent: isPercent(primary?.used_percent) ? primary.used_percent : null,
            secondaryPercent: isPercent(secondary?.used_percent) ? secondary.used_percent : null,
            primaryResetAt: isFiniteNumber(primary?.reset_at) && primary.reset_at >= 0 ? primary.reset_at : null,
            secondaryResetAt: isFiniteNumber(secondary?.reset_at) && secondary.reset_at >= 0 ? secondary.reset_at : null,
          }
          cached = { result, credentialHash, expiresAt: Date.now() + CACHE_MS }
          return result
        } catch (cause) {
          if (signal.aborted) throw cause
          return empty("upstream_error", "Could not retrieve usage; check Codex login/token expiry if fallback is enabled")
        }
      })()

      try {
        return await pending
      } finally {
        pending = undefined
      }
    }

    await ctx.rpc.register(CodexLimits, {
      usage: async (_input, { signal }) => loadUsage(signal),
    })
  },
})
