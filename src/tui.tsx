/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { For, Show, createSignal, onCleanup, onMount } from "solid-js"
import { CodexLimits } from "./rpc.ts"
import { resetLabel, stackedBar, usageBar } from "./format.ts"

const REFRESH_MS = 5 * 60 * 1000
type UsageData = {
  status: "ready" | "hidden" | "not_connected" | "unsupported_auth" | "upstream_error"
  message: string
  source: "opencode" | "codex" | "none"
  primaryPercent: number | null
  secondaryPercent: number | null
  primaryResetAt: number | null
  secondaryResetAt: number | null
}

function percent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)}%`
}

function remaining(value: number | null | undefined): number | null {
  return value === null || value === undefined ? null : Math.round(100 - Math.min(100, Math.max(0, value)))
}

function UsageStatus(props: { load: () => Promise<UsageData>; mode: "footer" | "sidebar" }) {
  const context = usePlugin()
  const [usage, setUsage] = createSignal<UsageData>()
  const [error, setError] = createSignal("")
  const [now, setNow] = createSignal(Date.now())
  const reset = () => resetLabel(usage()?.primaryResetAt ?? null, now())
  const weeklyReset = () => resetLabel(usage()?.secondaryResetAt ?? null, now(), true)
  const remainingColor = (value: number | null) =>
    value !== null && value <= 10 ? context.theme.text.feedback.error.base
      : value !== null && value <= 25 ? context.theme.text.feedback.warning.base
        : context.theme.text.feedback.success.base
  const footerPercentColor = (value: number | null) =>
    value !== null && value <= 10 ? context.theme.text.feedback.error.base
      : value !== null && value <= 25 ? context.theme.text.feedback.warning.base
        : context.theme.text.base

  const refresh = async () => {
    try {
      const result = await props.load()
      setUsage(result)
      setError("")
    } catch {
      setError("Usage service unavailable")
    }
  }

  onMount(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), REFRESH_MS)
    const clock = setInterval(() => setNow(Date.now()), 60_000)
    onCleanup(() => {
      clearInterval(timer)
      clearInterval(clock)
    })
  })

  return (
    <Show when={usage()?.status !== "hidden"}>
    <box flexDirection="column">
      <Show when={!error() && usage()?.status === "ready"}
        fallback={<text fg={context.theme.text.base}>{`OpenAI limits: ${error() || usage()?.message || "Loading…"}`}</text>}>
        <Show when={props.mode === "sidebar"} fallback={
          <box flexDirection="row">
            <text fg={context.theme.text.base}>{`OpenAI${reset() ? ` ↻ ${reset()}` : ""} `}</text>
            <box flexDirection="row" flexShrink={0}>
              <For each={stackedBar(remaining(usage()?.primaryPercent ?? null), remaining(usage()?.secondaryPercent ?? null))}>
                {(cell) => <text
                  fg={cell.top ? remainingColor(remaining(usage()?.primaryPercent ?? null)) : context.theme.background.raised.base}
                  bg={cell.bottom ? remainingColor(remaining(usage()?.secondaryPercent ?? null)) : context.theme.background.raised.base}
                >▀</text>}
              </For>
            </box>
            <text fg={footerPercentColor(remaining(usage()?.primaryPercent ?? null))}>{` ${percent(remaining(usage()?.primaryPercent ?? null))}`}</text>
          </box>
        }>
          <box flexDirection="row">
            <text fg={context.theme.text.base}>OpenAI</text>
            <Show when={usage()?.source === "codex"}>
              <text fg={context.theme.text.feedback.info.base}> [Codex]</text>
            </Show>
          </box>
          <text marginTop={1} fg={context.theme.text.muted}>{`Primary${reset() ? ` ↻ ${reset()}` : ""}`}</text>
          <text fg={remainingColor(remaining(usage()?.primaryPercent ?? null))}>{`${usageBar(remaining(usage()?.primaryPercent ?? null))} ${percent(remaining(usage()?.primaryPercent ?? null))}`}</text>
          <text marginTop={1} fg={context.theme.text.muted}>{`Weekly${weeklyReset() ? ` ↻ ${weeklyReset()}` : ""}`}</text>
          <text fg={remainingColor(remaining(usage()?.secondaryPercent ?? null))}>{`${usageBar(remaining(usage()?.secondaryPercent ?? null))} ${percent(remaining(usage()?.secondaryPercent ?? null))}`}</text>
        </Show>
      </Show>
    </box>
    </Show>
  )
}

export default Plugin.define({
  id: "opencode-openai-limits-tui",
  setup(context) {
    const api = context.client.rpc(CodexLimits)
    const load = async (): Promise<UsageData> => (await api.usage({}, {
      location: context.location ?? context.data.location.default(),
    })) as UsageData
    context.ui.slot({ append: "home.footer.status", render: () => <UsageStatus load={load} mode="footer" /> })
    context.ui.slot({
      append: "prompt.footer.status",
      render: () => (
        <Show when={context.ui.router.current().type === "session"}>
          <UsageStatus load={load} mode="footer" />
        </Show>
      ),
    })
    context.ui.slot({ append: "sidebar.content", render: () => <UsageStatus load={load} mode="sidebar" /> })
  },
})
