// Speaks the same sample lines in every installed Windows voice, at two speeds,
// and writes a page to listen to them side by side:
//
//   npm run voices -w @structura/video     → out/voice-samples/index.html
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'out/voice-samples')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const SAMPLES = [
  { id: 'hinglish', label: 'Hinglish', text: 'Interviewer bola. Ek U R L shortener design karo. Sirf saat characters, aur har din das crore naye links.' },
  { id: 'english', label: 'English', text: 'A key generator hands out the next unique number, and base 62 writes it in just seven characters.' },
]
const RATES = [1.0, 1.15]

const voices = execFileSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-Command',
    "Add-Type -AssemblyName System.Runtime.WindowsRuntime; $null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]; [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | ForEach-Object { $_.DisplayName + '|' + $_.Language + '|' + $_.Gender }",
  ],
  { encoding: 'utf8' },
)
  .trim()
  .split(/\r?\n/)
  .map((row) => {
    const [display, language, gender] = row.split('|')
    return { name: display.replace('Microsoft ', ''), language, gender }
  })

const textFile = join(outDir, '.line.txt')
const rows = []
for (const voice of voices) {
  const cells = []
  for (const sample of SAMPLES) {
    for (const rate of RATES) {
      const file = `${voice.name}-${sample.id}-${rate}.wav`
      writeFileSync(textFile, sample.text, 'utf8')
      execFileSync(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts/speak.ps1'), '-TextFile', textFile, '-OutFile', join(outDir, file), '-Voice', voice.name, '-Rate', String(rate)],
        { stdio: ['ignore', 'ignore', 'inherit'] },
      )
      cells.push(`<td><audio controls preload="none" src="${file}"></audio></td>`)
      console.log(`${voice.name.padEnd(8)} ${sample.label.padEnd(9)} ${rate}×`)
    }
  }
  rows.push(`<tr><th>${voice.name}<small>${voice.language} · ${voice.gender}</small></th>${cells.join('')}</tr>`)
}
rmSync(textFile, { force: true })

const head = SAMPLES.flatMap((s) => RATES.map((r) => `<th>${s.label} · ${r === 1 ? 'normal' : `${r}× faster`}</th>`)).join('')
writeFileSync(
  join(outDir, 'index.html'),
  `<!doctype html><meta charset="utf-8"><title>Voice samples</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; background: #0b0d12; color: #e5e7eb; margin: 32px; }
  table { border-collapse: collapse; } th, td { padding: 10px 12px; border-bottom: 1px solid #1f2937; text-align: left; }
  th small { display: block; color: #9ca3af; font-weight: 400; } audio { width: 220px; }
  blockquote { color: #9ca3af; margin: 4px 0 20px; }
</style>
<h1>Voice samples</h1>
<blockquote>Hinglish: “${SAMPLES[0].text}”<br>English: “${SAMPLES[1].text}”</blockquote>
<table><tr><th>Voice</th>${head}</tr>${rows.join('')}</table>
<p>Set the one you like as "voice" in src/narration/&lt;video&gt;.json, then run npm run voice.</p>`,
)
console.log(`\n${voices.length} voices → out/voice-samples/index.html`)
