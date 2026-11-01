import { useAuthRequestOwner } from '../../UserBlock/hooks/useAuthRequestOwner';
import { useBridge } from '../../McpBridge/hooks/useBridge';
import { embeddingInstallations, pendingEmbeddingInspection } from '../connection';
import { useEmbeddingInstallation } from './useEmbeddingInstallation';
import { sha } from '../model';
import { uuid } from '../../McpBridge/operationHelpers';
import type { IReindexConnectionTarget } from '../reindex';
import { useState } from 'react';
import type { TTargetBlocker } from './useEmbeddingTarget.interfaces';

/** A model intent captures exactly the computer/installation visible to the user. */
export function useEmbeddingTarget(projectId: string | undefined) {
    const [mode, setMode] = useState<'server' | 'computer'>('computer');
    const bridge = useBridge(!!projectId),
        { scope } = useAuthRequestOwner(),
        device = bridge.device;
    const binding = device?.report.bindings?.find((value) => value.projectId === projectId && value.valid !== false);
    const choices = projectId
        ? embeddingInstallations(bridge.installations, device, projectId, bridge.jobs).filter(
              (item) => item.hostedEmbedding?.reindexSupported,
          )
        : [];
    const ready = bridge.devicesReady && bridge.jobsReady && bridge.installationsReady;
    const installation = useEmbeddingInstallation(
        JSON.stringify([scope, projectId, device?.id, device?.report.root, binding?.bindingId, binding?.instanceId]),
        choices,
        ready,
    );
    const item = installation.item;
    const inspection =
        projectId && !choices.length
            ? pendingEmbeddingInspection(bridge.installations, device, projectId, bridge.jobs, item)
            : undefined;
    const blocker: TTargetBlocker | undefined = !ready
        ? 'loading'
        : !device
          ? 'computer'
          : !device.report.capabilities?.includes('hosted-rag-reindex-v1') ||
              !device.report.capabilities?.includes('hosted-rag-grants-v1') ||
              !device.report.capabilities?.includes('hosted-rag-profile-values-v1')
            ? 'bridge'
            : !binding || !sha(binding.bindingId) || !uuid(binding.instanceId)
              ? 'binding'
              : !installation.eligible || !item
                ? choices.length
                    ? 'selection'
                    : inspection
                      ? 'inspection'
                      : 'installation'
                : undefined;
    const reason = blocker
        ? {
              loading: bridge.error || 'Дождитесь актуального списка компьютеров и установок.',
              computer: 'Выберите компьютер для локального OpenCodeRAG.',
              bridge: 'Обновите мост для подключения модели и переиндексации одним действием.',
              binding: 'Свяжите папку проекта с выбранным компьютером.',
              installation:
                  'Установите OpenCodeRAG из каталога и проверьте его файлы в блоке «На этом компьютере». После этого выберите установку для подключения модели.',
              selection: 'Выберите доступную проверенную установку OpenCodeRAG.',
              inspection:
                  'OpenCodeRAG установлен. Проверяем файлы… Подключение модели станет доступно после успешной сверки.',
          }[blocker]
        : '';
    const value: IReindexConnectionTarget | undefined =
        mode === 'computer' && !reason && item && device && binding
            ? {
                  deviceId: device.id,
                  assetId: item.assetId,
                  assetKind: item.assetKind as 'mcp' | 'plugin',
                  version: item.version,
                  expectedManifest: item.manifest,
                  expectedBindingId: binding.bindingId!,
                  expectedInstanceId: binding.instanceId!,
              }
            : undefined;
    return {
        projectId,
        bridge,
        device,
        binding,
        item,
        choices,
        installation,
        ready,
        blocker,
        reason,
        value,
        mode,
        setMode,
        blocked: mode === 'computer' && !value,
    };
}
