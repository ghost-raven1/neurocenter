/** Version comparison has the same canonical, safely representable numeric parts in the API, installer UI and import gate. */
export function validBridgeVersion(value: unknown): value is string {
    return (
        typeof value === 'string' &&
        /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) &&
        value.split('.').every((part) => Number.isSafeInteger(Number(part)))
    );
}
