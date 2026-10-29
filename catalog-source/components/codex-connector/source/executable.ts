import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** Use the tested project dependency instead of whichever global Codex happens to be on PATH. */
export function codexExecutable(): { command: string; args: string[] } {
  const manifest = createRequire(import.meta.url).resolve("@openai/codex/package.json");
  // OpenCode embeds Bun: its execPath is the OpenCode binary, not a JavaScript runner.
  const command = process.versions.bun ? "node" : process.execPath;
  return { command, args: [join(dirname(manifest), "bin", "codex.js")] };
}
