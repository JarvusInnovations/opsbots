// Leaf module: imports nothing, so bin.ts can answer --version before the
// command graph loads. The literal is injected by scripts/build-cli.ts from
// `git describe`; unbundled (tests, `bun src/...`) it is "dev".
declare const __OPSBOT_CORE_VERSION__: string;
export const VERSION: string =
  typeof __OPSBOT_CORE_VERSION__ === "string" ? __OPSBOT_CORE_VERSION__ : "dev";
