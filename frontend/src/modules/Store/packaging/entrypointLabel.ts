/** Generated Python launchers display their command name while requests retain the exact checked path. */
export function entrypointLabel(entrypoint: string): string {
    return /^__neurocenter_python__\/([A-Za-z0-9._-]+)\.py$/.exec(entrypoint)?.[1] ?? entrypoint;
}
