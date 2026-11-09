// Leaf module: imports nothing, so bin.ts can answer --version before the command graph loads.
// The literal is injected by scripts/build-cli.ts; unbundled it is "dev".
declare const __OPSBOT_HOST_VERSION__: string;
export const VERSION: string =
  typeof __OPSBOT_HOST_VERSION__ === "string" ? __OPSBOT_HOST_VERSION__ : "dev";
