import { readCodexSession, type CodexSession } from "./auth-session.js";

const CODEX_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const ALLOWED_REQUESTS = new Set([CODEX_ENDPOINT, "https://api.openai.com/v1/responses"]);
type SessionReader = (refresh?: boolean) => Promise<CodexSession>;

/** Consume a streamed Responses reply for SDK doGenerate callers (for example session titles). */
async function responseAsJson(response: Response): Promise<Response> {
  if (!response.body) throw new Error("Codex returned an empty response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 16 * 1024 * 1024) throw new Error("Codex response exceeds 16 MiB");
      buffer += decoder.decode(part.value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = event.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (!data || data === "[DONE]") continue;
        const parsed = JSON.parse(data);
        if (parsed.type === "response.completed" || parsed.type === "response.incomplete") {
          return new Response(JSON.stringify(parsed.response), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (parsed.type === "response.failed" || parsed.type === "error") throw new Error("Codex response failed");
      }
    }
    throw new Error("Codex stream ended before its final response");
  } finally { await reader.cancel().catch(() => undefined); }
}

/** Use the supported Codex Responses endpoint while OpenCode retains its normal tools and approvals. */
export function createCodexFetch(readSession: SessionReader = readCodexSession, transport: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const inputUrl = input instanceof Request ? input.url : String(input);
    if (!ALLOWED_REQUESTS.has(inputUrl)) throw new Error("CodexBridge only authenticates the official Codex Responses endpoint");
    const request = new Request(input, init);
    if (request.method !== "POST") throw new Error("CodexBridge only accepts Responses POST requests");
    const body = await request.json() as Record<string, unknown>;
    const streaming = body.stream === true;
    body.stream = true;
    body.store = false;
    body.instructions ??= "";
    // ChatGPT's Codex transport controls these parameters; the API SDK otherwise emits API-only options.
    for (const field of ["max_output_tokens", "temperature", "top_p", "frequency_penalty", "presence_penalty", "truncation"]) delete body[field];
    const payload = JSON.stringify(body);
    for (let attempt = 0; attempt < 2; attempt++) {
      request.signal.throwIfAborted();
      const session = await readSession(attempt === 1);
      const headers = new Headers(request.headers);
      headers.set("authorization", `Bearer ${session.accessToken}`);
      headers.set("ChatGPT-Account-Id", session.accountId);
      headers.set("originator", "codexbridge");
      headers.set("content-type", "application/json");
      headers.set("accept", "text/event-stream");
      headers.delete("content-length");
      const response = await transport(CODEX_ENDPOINT, {
        method: "POST", headers, body: payload, signal: request.signal, redirect: "error",
      });
      if (response.status === 401 && attempt === 0) { await response.body?.cancel(); continue; }
      if (!response.ok || streaming) return response;
      return responseAsJson(response);
    }
    throw new Error("Codex authentication failed after refresh");
  };
}
