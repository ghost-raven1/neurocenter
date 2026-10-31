/** Canonicalizes only the complete version lines emitted by the V1 and V2 CLIs. */
export function observedOpenCodeVersion(output: string): string | undefined {
    const line = output.trim();
    if (line.length > 128) return undefined;
    return /^(?:opencode v)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?)$/.exec(
        line,
    )?.[1];
}
