import { describe, expect, it } from 'vitest';
import { bridgeJobOperationId, isApplicationPath, operationsDeepLink } from '../operationLinks';

describe('operationsDeepLink (8.19 P2-4)', () => {
    it('builds a plain operations page link without parameters', () => {
        expect(operationsDeepLink()).toBe('/operations');
    });
    it('adds the operation id', () => {
        expect(operationsDeepLink('bridge-abc')).toBe('/operations?operation=bridge-abc');
    });
    it('encodes the return destination together with the operation', () => {
        expect(operationsDeepLink('op-1', '/projects/abc?tab=rag')).toBe(
            '/operations?operation=op-1&return=%2Fprojects%2Fabc%3Ftab%3Drag',
        );
    });
    it('keeps a return destination without an operation', () => {
        expect(operationsDeepLink(undefined, '/assets')).toBe('/operations?return=%2Fassets');
    });
    it('drops protocol-relative, external, relative and empty destinations', () => {
        expect(operationsDeepLink('op-1', '//evil.example')).toBe('/operations?operation=op-1');
        expect(operationsDeepLink('op-1', 'https://evil.example/')).toBe('/operations?operation=op-1');
        expect(operationsDeepLink('op-1', 'operations')).toBe('/operations?operation=op-1');
        expect(operationsDeepLink('op-1', '')).toBe('/operations?operation=op-1');
        expect(operationsDeepLink('op-1', null as never)).toBe('/operations?operation=op-1');
    });
    it('drops an overlong destination', () => {
        expect(operationsDeepLink('op-1', '/' + 'a'.repeat(2049))).toBe('/operations?operation=op-1');
    });
});

describe('isApplicationPath', () => {
    it.each([
        ['/projects/abc?tab=rag', true],
        ['/store', true],
        ['//evil.example', false],
        ['https://x', false],
        ['relative', false],
        ['', false],
        [null, false],
        [undefined, false],
    ])('checks %s', (value, allowed) => {
        expect(isApplicationPath(value as never)).toBe(allowed);
    });
});

describe('bridgeJobOperationId', () => {
    it('mirrors the server projection of device jobs', () => {
        expect(bridgeJobOperationId('11111111-1111-4111-8111-111111111111')).toBe(
            'bridge-11111111-1111-4111-8111-111111111111',
        );
    });
});
