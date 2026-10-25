import assert from "node:assert/strict"
import { test } from "node:test"
import { claims, identity } from "./codex-auth.ts"

const jwt = (payload: unknown) => `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`

test("malformed token does not expose an identity", () => {
  assert.deepEqual(claims("invalid"), {})
  assert.equal(identity("invalid"), undefined)
})

test("client-specific subjects must not be compared across OAuth methods", () => {
  assert.equal(identity(jwt({ sub: "client-specific-subject" })), undefined)
})

test("uses only the explicit ChatGPT account identifier", () => {
  assert.equal(identity(jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "account-1" } })), "account-1")
})
