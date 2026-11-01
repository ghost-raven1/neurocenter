/** Count UTF-8 bytes consistently for payload and draft size limits. */
export const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).byteLength;
