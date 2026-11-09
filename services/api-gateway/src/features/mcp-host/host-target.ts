import { getHostTarget } from '../../../../shared/runtime/host-target.cjs';

/** Runtime descriptors use the Gateway's platform, including Linux libc. Unknown libc is never guessed. */
export function hostRuntimeTarget(): string {
    return getHostTarget({ mode: 'throw' });
}
