/** Ответ действителен только для текущего владельца и последнего запроса блока. */
export function createMaintenanceRequestScope() {
    let active = false;
    let owner = 0;
    let request = 0;

    const captureOwner = (): (() => boolean) => {
        const currentOwner = owner;
        return () => active && currentOwner === owner;
    };

    return {
        activate(): void {
            active = true;
            owner++;
        },
        dispose(): void {
            active = false;
            owner++;
        },
        isActive(): boolean {
            return active;
        },
        captureOwner,
        next(): () => boolean {
            const isOwnerCurrent = captureOwner();
            const currentRequest = ++request;
            return () => isOwnerCurrent() && currentRequest === request;
        },
    };
}
