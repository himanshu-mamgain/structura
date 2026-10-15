import { type CalculateMetadataFunction, Composition, staticFile } from 'remotion'
import * as DockerVsVm from './DockerVsVm'
import * as Ep01 from './episodes/Ep01UrlShortener'
import * as Rbac from './Rbac'
import { FPS, HEIGHT, WIDTH } from './theme'
import * as UberSurge from './UberSurge'
import * as UrlShortener from './UrlShortener'
import type { VideoProps } from './ui'

/**
 * Reads the narration lengths written by `npm run voice`, so captions and scenes
 * follow the voice. Without them the video renders silently with planned timings.
 */
function withVoice(video: string, duration: (voice: VideoProps['voice']) => number): CalculateMetadataFunction<VideoProps> {
  return async ({ props }) => {
    let voice: VideoProps['voice'] = null
    try {
      const response = await fetch(staticFile(`voice/${video}/manifest.json`))
      if (response.ok) voice = ((await response.json()) as { lines: Record<string, number> }).lines
    } catch {
      // No narration generated yet.
    }
    return { props: { ...props, voice }, durationInFrames: duration(voice) }
  }
}

const common = { fps: FPS, width: WIDTH, height: HEIGHT, defaultProps: { voice: null } }

/** Every video this workspace can render. */
export function Root() {
  return (
    <>
      <Composition
        id="DockerVsVm"
        component={DockerVsVm.DockerVsVm}
        calculateMetadata={withVoice(DockerVsVm.VIDEO, DockerVsVm.duration)}
        durationInFrames={DockerVsVm.duration(null)}
        {...common}
      />
      <Composition
        id="UberSurge"
        component={UberSurge.UberSurge}
        calculateMetadata={withVoice(UberSurge.VIDEO, UberSurge.duration)}
        durationInFrames={UberSurge.duration(null)}
        {...common}
      />
      <Composition
        id="UrlShortener"
        component={UrlShortener.UrlShortener}
        calculateMetadata={withVoice(UrlShortener.VIDEO, UrlShortener.duration)}
        durationInFrames={UrlShortener.duration(null)}
        {...common}
      />
      <Composition
        id="Rbac"
        component={Rbac.Rbac}
        calculateMetadata={withVoice(Rbac.VIDEO, Rbac.duration)}
        durationInFrames={Rbac.duration(null)}
        {...common}
      />
      <Composition
        id="Ep01UrlShortener"
        component={Ep01.Ep01UrlShortener}
        calculateMetadata={withVoice(Ep01.VIDEO, Ep01.duration)}
        durationInFrames={Ep01.duration(null)}
        {...common}
      />
    </>
  )
}
