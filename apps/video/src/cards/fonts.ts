import { loadFont } from '@remotion/fonts'
import interLatin500 from '@fontsource/inter/files/inter-latin-500-normal.woff2'
import interLatin700 from '@fontsource/inter/files/inter-latin-700-normal.woff2'
import interLatin800 from '@fontsource/inter/files/inter-latin-800-normal.woff2'
import interLatin900 from '@fontsource/inter/files/inter-latin-900-normal.woff2'
import interExt500 from '@fontsource/inter/files/inter-latin-ext-500-normal.woff2'
import interExt700 from '@fontsource/inter/files/inter-latin-ext-700-normal.woff2'
import interExt800 from '@fontsource/inter/files/inter-latin-ext-800-normal.woff2'
import interExt900 from '@fontsource/inter/files/inter-latin-ext-900-normal.woff2'
import mono500 from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff2'
import mono700 from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff2'
import mono800 from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-800-normal.woff2'

// Bundled fonts (SIL Open Font License), so a video looks the same whichever
// machine renders it. Latin-ext carries the ₹ sign. Remotion waits for these.

const LATIN_EXT = 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF'

const inter: [string, string, string][] = [
  ['500', interLatin500, interExt500],
  ['700', interLatin700, interExt700],
  ['800', interLatin800, interExt800],
  ['900', interLatin900, interExt900],
]
for (const [weight, latin, ext] of inter) {
  void loadFont({ family: 'Inter', url: latin, weight })
  void loadFont({ family: 'Inter', url: ext, weight, unicodeRange: LATIN_EXT })
}
for (const [weight, url] of [
  ['500', mono500],
  ['700', mono700],
  ['800', mono800],
]) {
  void loadFont({ family: 'JetBrains Mono', url, weight })
}

export const sans = 'Inter, "Segoe UI", system-ui, sans-serif'
// Inter after the mono font supplies ₹, which the mono font lacks.
export const mono = '"JetBrains Mono", Inter, Consolas, monospace'
