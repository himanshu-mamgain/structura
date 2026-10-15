import { Config } from '@remotion/cli/config'

// High-quality H.264 for sharing (Reels, Shorts, YouTube).
Config.setVideoImageFormat('jpeg')
Config.setJpegQuality(92)
Config.setCodec('h264')
Config.setCrf(18)

// WebGL for the three.js scenes; ANGLE works headless on Windows, macOS and Linux.
Config.setChromiumOpenGlRenderer('angle')
