// vite.config.ts points '@dbml/core' here. The data model view hands dbml-erd-viewer a
// ready-made schema (src/learn/dbml.ts), so the viewer never parses DBML in the browser,
// and the parser's 2.6 MB stays out of the build. The tests use the real one.
export class Parser {
  constructor() {
    throw new Error('The DBML parser is not in the app: pass the viewer a `schema`, not `dbml`.')
  }
}
