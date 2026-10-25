import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

type Claims = { exp?: number; sub?: string; "https://api.openai.com/auth"?: { chatgpt_account_id?: string; chatgpt_user_id?: string } }

// Claims are used only for expiry/account comparison, never as proof of authentication.
export function claims(token: string): Claims {
  try {
    const value = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString())
    return value && typeof value === "object" ? value : {}
  } catch { return {} }
}

export function identity(token: string): string | undefined {
  const value = claims(token)
  const auth = value["https://api.openai.com/auth"]
  // OAuth subjects can be client-specific (token sharing vs legacy Codex).
  // Never compare `sub` across these flows.
  const id = auth?.chatgpt_account_id
  return typeof id === "string" && id.length > 0 ? id : undefined
}

export async function readCodexAuth() {
  let data
  try {
    data = JSON.parse(await readFile(join(homedir(), ".codex", "auth.json"), "utf8"))
  } catch {
    throw new Error("Codex auth file unavailable or invalid; sign in with Codex")
  }
  const token = data?.tokens?.access_token
  if (typeof token !== "string" || !token || data?.auth_mode === "apikey") {
    throw new Error("Codex OAuth token missing; sign in with Codex")
  }
  const exp = claims(token).exp
  if (typeof exp === "number" && exp * 1000 <= Date.now()) {
    throw new Error("Codex token expired; renew your login in Codex")
  }
  const accountId = data.tokens.account_id
  return { access: token, accountId: typeof accountId === "string" ? accountId : undefined }
}
