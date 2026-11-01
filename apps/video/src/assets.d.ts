// Font files imported for their URL (Remotion's bundler serves them as assets).
declare module '*.woff2' {
  const url: string
  export default url
}
