# Speaks one line of text to a WAV file with Windows' built-in (OneCore) voices.
# Offline, no AI service. Run by voice.mjs; Windows PowerShell 5.1 only.
param(
  [Parameter(Mandatory = $true)] [string] $TextFile,
  [Parameter(Mandatory = $true)] [string] $OutFile,
  [string] $Voice = 'Heera',
  [double] $Rate = 1.0
)
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]

# WinRT calls are asynchronous; this waits for one and returns its result.
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } |
  Select-Object -First 1
function Await($operation, [Type] $resultType) {
  $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
  $task.Wait() | Out-Null
  $task.Result
}

$synth = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::new()
$match = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object { $_.DisplayName -like "*$Voice*" } | Select-Object -First 1
if (-not $match) {
  $names = ([Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | ForEach-Object { $_.DisplayName }) -join ', '
  throw "No voice matching '$Voice'. Installed: $names"
}
$synth.Voice = $match
$synth.Options.SpeakingRate = $Rate

$text = [IO.File]::ReadAllText($TextFile, [Text.Encoding]::UTF8)
$stream = Await ($synth.SynthesizeTextToStreamAsync($text)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
$reader = [Windows.Storage.Streams.DataReader]::new($stream.GetInputStreamAt(0))
$size = [uint32] $stream.Size
$null = Await ($reader.LoadAsync($size)) ([uint32])
$bytes = New-Object byte[] $size
$reader.ReadBytes($bytes)
[IO.File]::WriteAllBytes($OutFile, $bytes)
