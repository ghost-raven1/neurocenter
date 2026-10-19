import type { IBridgeDevice, IBridgeJob } from '../src/features/McpBridge/api';
import type { useBridge } from '../src/features/McpBridge/useBridge';
import type { IRagUiInstallation } from '../src/features/McpBridge/ragUi/ragUiState';

export function ragUiFixture() {
    const binding = { projectId: 'prj-one', bindingId: 'b'.repeat(64), instanceId: '11111111-1111-1111-1111-111111111111', folderName: 'Проект', valid: true };
    const device: IBridgeDevice = { id: 'device-one', name: 'Рабочий компьютер', role: 'Разработчик', fingerprint: 'fingerprint', online: true, lastSeen: '2026-10-19',
        report: { bridgeVersion: '0.9.5', protocolVersion: 2, capabilities: ['durable-completions', 'managed-installations', 'opencode-rag-ui-v1'], bindings: [binding] } };
    const item: IRagUiInstallation = { deviceId: device.id, projectId: binding.projectId, assetId: 'rag-mcp', assetKind: 'mcp', name: 'OpenCodeRAG', version: 3,
        manifest: 'a'.repeat(64), updatedAt: '2026-10-19T01:00:00Z', bindingId: binding.bindingId, isCurrentBinding: true, ragUi: { supported: true, mode: 'web' } };
    const job = (changes: Partial<IBridgeJob> = {}): IBridgeJob => ({ id: 'job-one', deviceId: device.id, projectId: binding.projectId, kind: 'open-rag-ui',
        state: 'queued', message: 'Открываем окно', assetId: item.assetId, assetKind: item.assetKind, version: String(item.version), bindingId: binding.bindingId,
        expectedManifest: item.manifest, expectedInstanceId: binding.instanceId, createdAt: '2026-10-19T01:00:00Z', updatedAt: '2026-10-19T01:00:00Z', ...changes });
    const bridge = { device, devices: [device], installations: [item], jobs: [] as IBridgeJob[], devicesReady: true, jobsReady: true, installationsReady: true,
        loading: false, errors: { devices: '', jobs: '', installations: '' }, error: '', reload: async () => undefined, choose: () => undefined } as ReturnType<typeof useBridge>;
    return { binding, device, item, job, bridge };
}
