import type { TuiPlugin, TuiPluginApi, TuiPluginModule, TuiSlotContext } from "@opencode-ai/plugin/tui"
import { createSignal, createMemo, onMount, onCleanup, Show, untrack } from "solid-js"

type UsageInfo = {
  placeholder?: boolean
  window_token_limit?: number
  window_tokens_used?: number
  usage_percent?: number
  window_hours?: number
  reset_at_display?: string
  seconds_until_reset?: number
  usage_status_desc?: string
}

type StatusResponse = {
  current_usage?: UsageInfo
  window_quota_exhausted?: boolean
}

const PROXY_URL = "http://127.0.0.1:9457/v1/usage"
const POLL_INTERVAL = 30_000

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return m > 0 ? `${m}分${s}秒` : `${s}秒`
}

function buildPctBar(pct: number, width: number): string {
  const filled = Math.round((pct / 100) * width)
  const empty = width - filled
  return "\u2588".repeat(filled) + "\u2591".repeat(empty)
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v
}

const tui: TuiPlugin = async (api: TuiPluginApi) => {
  const [usage, setUsage] = createSignal<UsageInfo | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [exhausted, setExhausted] = createSignal(false)
  const [collapsed, setCollapsed] = createSignal(true)
  const [activeSessionId, setActiveSessionId] = createSignal<string | null>(null)
  const [visible, setVisible] = createSignal(false)

  let intervalId: ReturnType<typeof setInterval> | null = null
  let guardIntervalId: ReturnType<typeof setInterval> | null = null

  async function fetchUsage() {
    try {
      const res = await fetch(PROXY_URL)
      if (!res.ok) throw new Error("HTTP " + res.status)
      const data: StatusResponse = await res.json()
      if (data.current_usage) {
        setUsage(data.current_usage)
        setExhausted(data.window_quota_exhausted || false)
        setError(null)
        untrack(() => api.kv.set("usage_snapshot", data))
      }
    } catch (e: any) {
      setError(e.message)
    }
  }

  function recheck() {
    try {
      const route = api.route.current
      if (route.name !== "session") { setVisible(false); return }
      const sid = route.params?.sessionID
      if (!sid) { setVisible(false); return }
      setActiveSessionId(sid)
      setVisible(true)
    } catch { setVisible(false) }
  }

  onMount(async () => {
    const saved = untrack(() => api.kv.get("usage_snapshot", null))
    if (saved?.current_usage) {
      setUsage(saved.current_usage)
      setExhausted(saved.window_quota_exhausted || false)
    }
    const savedCollapsed = untrack(() => api.kv.get("usage_collapsed", true))
    setCollapsed(savedCollapsed)

    recheck()
    if (visible()) fetchUsage()
    intervalId = setInterval(fetchUsage, POLL_INTERVAL)
    guardIntervalId = setInterval(recheck, 2000)

    api.event.on("session.updated", recheck)
    api.event.on("session.created", recheck)
    api.event.on("tui.session.select", recheck)
  })

  onCleanup(() => {
    if (intervalId) clearInterval(intervalId)
    if (guardIntervalId) clearInterval(guardIntervalId)
  })

  api.slots.register({
    order: 60,
    slots: {
      sidebar_content(ctx: TuiSlotContext, input: { session_id: string }) {
        const isActive = activeSessionId() === input.session_id

        const u = usage()
        const err = error()
        const isExhausted = exhausted()
        const isCollapsed = collapsed()
        const theme = ctx.theme.current

        const pct = createMemo(() => clamp(u?.usage_percent ?? 0, 0, 100))
        const barWidth = createMemo(() => (isCollapsed ? 8 : 20))

        const severityColor = createMemo(() => {
          const v = pct()
          if (v >= 95) return "red"
          if (v >= 80) return "yellow"
          return theme.text || "white"
        })

        const toggleCollapse = () => {
          const next = !isCollapsed
          setCollapsed(next)
          untrack(() => api.kv.set("usage_collapsed", next))
        }

        return (
          <box>
            <Show when={visible() && isActive}>
              <box flexDirection="column" paddingTop={1} paddingBottom={0} paddingLeft={1} paddingRight={1}>
                <text fg={severityColor()} onMouseUp={toggleCollapse}>
                  <span>{isCollapsed ? "\u25B6" : "\u25BC"} </span>
                  <span fg={theme.dim || "gray"}>AtomGit </span>
                  <span fg={severityColor()}>{buildPctBar(pct(), barWidth())}</span>
                  <span> {pct().toFixed(0)}%</span>
                </text>

                <Show when={!isCollapsed && (u || err)}>
                  <box flexDirection="column" paddingLeft={2}>
                    <Show when={err && !u}>
                      <text fg="red">{err}</text>
                    </Show>

                    <Show when={u}>
                      <text>
                        <span>调用: </span>
                        <span>{(u!.window_tokens_used ?? 0).toLocaleString()} / {(u!.window_token_limit ?? 0).toLocaleString()}</span>
                      </text>

                      <Show when={u?.window_hours}>
                        <text>
                          <span>窗口: </span>
                          <span>{u!.window_hours}小时</span>
                          <Show when={u?.reset_at_display}>
                            <span>{'\u00B7'} 重置 {u!.reset_at_display}</span>
                          </Show>
                        </text>
                      </Show>

                      <Show when={u?.seconds_until_reset}>
                        <text>
                          <span>剩余 {formatTime(u!.seconds_until_reset!)}</span>
                        </text>
                      </Show>

                      <Show when={isExhausted}>
                        <text fg="red">{'\u26A0\uFE0F'} 配额已用完</text>
                      </Show>
                    </Show>

                    <Show when={err && u}>
                      <text fg="yellow">{'\u26A0'} {err}</text>
                    </Show>
                  </box>
                </Show>
              </box>
            </Show>
          </box>
        )
      },
    },
  })
}

const mod: TuiPluginModule & { id: string } = {
  id: "atomgit-usage",
  tui,
}

export default mod
