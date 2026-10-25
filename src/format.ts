export function usageBar(value: number | null, width = 16): string {
  if (value === null || !Number.isFinite(value)) return "░".repeat(width)
  const filled = Math.round(Math.min(100, Math.max(0, value)) / 100 * width)
  return "█".repeat(filled) + "░".repeat(width - filled)
}

export function stackedBar(primary: number | null, weekly: number | null, width = 12) {
  const filled = (value: number | null) => value === null || !Number.isFinite(value)
    ? 0 : Math.round(Math.min(100, Math.max(0, value)) / 100 * width)
  const top = filled(primary)
  const bottom = filled(weekly)
  return Array.from({ length: width }, (_, index) => ({ top: index < top, bottom: index < bottom }))
}

export function resetLabel(timestamp: number | null, now: number, showDays = false): string {
  if (timestamp === null || !Number.isFinite(timestamp)) return ""
  const remaining = Math.max(0, timestamp * 1000 - now)
  const hours = Math.floor(remaining / 3_600_000)
  const minutes = Math.floor((remaining % 3_600_000) / 60_000)
  if (showDays && hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}
