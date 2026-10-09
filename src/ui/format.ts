/** Distances as a photographer reads them: cm under a metre, ∞ at infinity. */
export function formatDistance(m: number | null): string {
  if (m === null) return '—'
  if (!Number.isFinite(m)) return '∞'
  if (m < 0.1) return `${(m * 100).toFixed(1)} cm`
  if (m < 1) return `${Math.round(m * 100)} cm`
  if (m < 10) return `${m.toFixed(2)} m`
  if (m < 100) return `${m.toFixed(1)} m`
  return `${Math.round(m)} m`
}

export const formatStop = (N: number): string => `f/${N}`
