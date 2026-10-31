const CODEX_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const ALLOWED_REQUESTS = new Set([CODEX_ENDPOINT, "https://api.openai.com/v1/responses"]);

const CODEX_PROVIDER_ID = "codexbridge";
const CODEX_AUTH_MARKER = "codexbridge-managed";

export { CODEX_ENDPOINT, ALLOWED_REQUESTS, CODEX_PROVIDER_ID, CODEX_AUTH_MARKER };