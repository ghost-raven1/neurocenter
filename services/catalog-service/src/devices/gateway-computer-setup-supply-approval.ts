import { ConflictException, Injectable } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { normalizeOpenCodeInstallSupply, type OpenCodeInstallSupply } from '../../../shared/opencode-cli-install.cjs';
import { ComputerSetupSupplyApproval } from './computer-setup-supply-approval';

/** Device reports cannot authorize bytes; only the configured Gateway's canonical supply may. */
@Injectable()
export class GatewayComputerSetupSupplyApproval extends ComputerSetupSupplyApproval {
    private readonly base = (process.env.API_GATEWAY_URL || 'http://localhost:4000').replace(/\/+$/, '');
    async requireOpenCode(value: OpenCodeInstallSupply, signal?: AbortSignal): Promise<void> {
        try {
            const supply = normalizeOpenCodeInstallSupply(value),
                token = process.env.NEUROCENTER_INTERNAL_TOKEN;
            if (!token) throw Error();
            const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000);
            const response = await fetch(
                this.base + '/internal/bridge/opencode-cli-supply/' + encodeURIComponent(supply.target),
                {
                    headers: { 'x-neurocenter-internal': token },
                    signal: bounded,
                    redirect: 'error',
                },
            );
            if (response.status !== 200) {
                await response.body?.cancel();
                throw Error();
            }
            const reader = response.body?.getReader(),
                parts: Uint8Array[] = [];
            let bytes = 0;
            try {
                if (reader)
                    for (;;) {
                        const part = await reader.read();
                        if (part.done) break;
                        bytes += part.value.byteLength;
                        if (bytes > 4096) {
                            await reader.cancel();
                            throw Error();
                        }
                        parts.push(part.value);
                    }
            } finally {
                reader?.releaseLock();
            }
            const approved = JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown;
            if (!isDeepStrictEqual(normalizeOpenCodeInstallSupply(approved), supply)) throw Error();
        } catch {
            throw new ConflictException({
                code: 'computer-setup-supply-unavailable',
                message:
                    'Поставка OpenCode на компьютере не совпадает с актуальной поставкой площадки. Обновите мост и повторите проверку.',
            });
        }
    }
}
