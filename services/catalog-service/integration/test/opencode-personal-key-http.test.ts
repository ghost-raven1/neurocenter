import 'reflect-metadata';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { OpenCodePersonalKeyController } from '../../src/opencode-personal-key/controller';
import { OpenCodePersonalKeyService } from '../../src/opencode-personal-key/service';
const service = {
    context: vi.fn(async () => ({ ok: true })),
    save: vi.fn(async () => ({ hasKey: true })),
    receipt: vi.fn(async () => ({ receipt: null })),
};
class FixtureModule {}
Module({
    controllers: [OpenCodePersonalKeyController],
    providers: [{ provide: OpenCodePersonalKeyService, useValue: service }],
})(FixtureModule);
let app: INestApplication, url: string;
const previous = Reflect.getMetadata('design:paramtypes', OpenCodePersonalKeyController);
beforeAll(async () => {
    vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN', 'owned-http-fixture');
    // Vitest does not emit TS design metadata; bind only the external service dependency for the real router.
    Reflect.defineMetadata('design:paramtypes', [OpenCodePersonalKeyService], OpenCodePersonalKeyController);
    app = await NestFactory.create(FixtureModule, { logger: false, abortOnError: false });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
});
afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
    if (previous) Reflect.defineMetadata('design:paramtypes', previous, OpenCodePersonalKeyController);
    else Reflect.deleteMetadata('design:paramtypes', OpenCodePersonalKeyController);
});
it.each(['context', 'save', 'receipt'] as const)(
    'private %s endpoint responds HTTP200 through the actual Nest router',
    async (action) => {
        const body = action === 'save' ? { jobId: 'fixture-job', apiKey: 'synthetic-key' } : { jobId: 'fixture-job' };
        const response = await fetch(url + '/internal/device-channel/opencode-personal-key/' + action, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-neurocenter-internal': 'owned-http-fixture',
                Authorization: 'Bearer owned-device',
            },
            body: JSON.stringify(body),
        });
        expect(response.status).toBe(200);
        expect(service[action]).toHaveBeenCalledWith('owned-device', body);
        expect(await response.text()).not.toContain('synthetic-key');
    },
);
it('missing internal authorization cannot reach private service', async () => {
    const before = service.save.mock.calls.length;
    const response = await fetch(url + '/internal/device-channel/opencode-personal-key/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: 'fixture-job', apiKey: 'synthetic-key' }),
    });
    expect(response.status).toBe(403);
    expect(service.save.mock.calls.length).toBe(before);
    expect(await response.text()).not.toContain('synthetic-key');
});
