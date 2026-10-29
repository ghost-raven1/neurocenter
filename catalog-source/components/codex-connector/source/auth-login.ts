import type { AuthHook } from "@opencode-ai/plugin";
type AuthOAuthResult = Awaited<ReturnType<Extract<AuthHook["methods"][number], { type: "oauth" }>["authorize"]>>;
import { CodexConnection } from "./connection.js";
import { CODEX_AUTH_MARKER, invalidateCodexSession } from "./auth-session.js";
import type { RpcMessage } from "./types.js";

/** Start the official Codex browser flow; only Codex receives and persists refresh credentials. */
export async function beginCodexLogin(
  connection: Pick<CodexConnection, "initialize" | "call" | "close" | "on"> = new CodexConnection(),
  onComplete: () => void = invalidateCodexSession,
): Promise<AuthOAuthResult> {
  let loginId: string | undefined;
  const early: RpcMessage[] = [];
  let resolveDone!: () => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  const timeout = setTimeout(() => rejectDone(new Error("Codex login timed out; start it again when ready")), 10 * 60_000);
  timeout.unref();
  const cleanup = async () => { clearTimeout(timeout); await connection.close(); };
  void done.then(cleanup, cleanup).catch(() => undefined);
  connection.on("failure", () => rejectDone(new Error("Codex login connection closed")));
  const completed = (message: RpcMessage) => {
    if (message.method !== "account/login/completed") return;
    if (!loginId) { early.push(message); return; }
    if (message.params?.loginId !== loginId) return;
    if (message.params?.success === true) resolveDone();
    else rejectDone(new Error("Codex login was not completed"));
  };
  connection.on("message", completed);
  try {
    await connection.initialize();
    const result = await connection.call("account/login/start", { type: "chatgpt" }) as { type?: string; authUrl?: string; loginId?: string };
    if (result.type !== "chatgpt" || !result.authUrl || !result.loginId) throw new Error("Codex did not return a browser login URL");
    const url = new URL(result.authUrl);
    if (url.protocol !== "https:" || !["auth.openai.com", "chatgpt.com"].includes(url.hostname)) throw new Error("Unexpected Codex login host");
    loginId = result.loginId;
    early.forEach(completed);
    return {
      url: url.href, instructions: "Finish signing into ChatGPT in the browser. CodexBridge uses the Codex credential store.",
      method: "auto",
      async callback() {
        await done;
        onComplete();
        return { type: "success", key: CODEX_AUTH_MARKER };
      },
    };
  } catch (error) {
    rejectDone(new Error("Could not start Codex login"));
    await cleanup();
    throw error;
  }
}
