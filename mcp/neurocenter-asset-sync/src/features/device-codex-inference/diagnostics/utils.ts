/** Accept only integer HTTP response status codes for persisted diagnostics. */
export const isHttpStatus = (value: unknown): value is number =>
    Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 599;
