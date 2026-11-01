const CODEX_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';
const ALLOWED_REQUESTS = new Set([CODEX_ENDPOINT, 'https://api.openai.com/v1/responses']);

export { CODEX_ENDPOINT, ALLOWED_REQUESTS };
