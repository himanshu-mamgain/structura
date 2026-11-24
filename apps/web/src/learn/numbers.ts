/**
 * Big numbers the way people say them: 1k, 200k, 1 million, 2.5 billion. The owner asked for
 * this everywhere a learner reads a number, because a row of zeros is hard to read at a glance.
 * Only exact values are shortened, so 33,333 or 65,536 stay as they are (round them yourself,
 * with "about", where an exact value doesn't matter).
 */
const UNITS: [number, string, number][] = [
  [1e12, ' trillion', 2],
  [1e9, ' billion', 2],
  [1e6, ' million', 2],
  [1e3, 'k', 1],
]

export function shortNumber(x: number): string {
  const n = Math.abs(x)
  for (const [unit, word, digits] of UNITS) {
    if (n < unit) continue
    const v = Number((n / unit).toFixed(digits))
    if (Math.abs(v * unit - n) > 1e-6) break
    // 1,200 reads better as it is than as 1.2k.
    if (unit === 1e3 && !Number.isInteger(v) && n < 10_000) break
    return (x < 0 ? '−' : '') + v + word
  }
  return x.toLocaleString('en-US')
}
