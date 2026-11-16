import { useAuthRequestOwner } from '../../UserBlock/hooks/useAuthRequestOwner';
import { useBridge } from '../../McpBridge/hooks/useBridge';
import { embeddingInstallations, pendingEmbeddingInspection } from '../connection';
import { useEmbeddingInstallation } from './useEmbeddingInstallation';
import { sha, projectEmbeddingApi, targetInstallationKey, type IProjectEmbeddingTarget } from '../model';
import { uuid } from '../../McpBridge/operationHelpers';
import type { IReindexConnectionTarget } from '../reindex';
import { useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import type { TRootState } from '../../../store';
import { projectRoleLevel } from '../../UserBlock/roles';
import type { TTargetBlocker } from './useEmbeddingTarget.interfaces';

/** A model intent captures exactly the computer/installation visible to the user. */
export function useEmbeddingTarget(projectId: string | undefined, persisted?: IProjectEmbeddingTarget | null) {
    const user = useSelector((state: TRootState) => state.userBlock.user);
    const [mode, setModeState] = useState<'server' | 'computer'>(() => persisted?.mode ?? 'computer');
    const modeTouched = useRef(false);
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
    const persistedInstallation =
        persisted?.mode === 'computer' && persisted.installation ? persisted.installation : undefined;
    // Персист проекта задаёт компьютер, на котором ждёт модель; выбор глобального моста подгоняется один раз.
    const wantedDeviceId = mode === 'computer' && ready && persistedInstallation?.deviceId;
    useEffect(() => {
        if (!wantedDeviceId || device?.id === wantedDeviceId) return;
        if (!bridge.devices.some((item) => item.id === wantedDeviceId)) return;
        void bridge.choose(wantedDeviceId);
    }, [wantedDeviceId, device?.id, bridge.devices, bridge]);
    // Непрочитанный серверный персист догоняет локальный режим, пока пользователь не тронул выбор.
    useEffect(() => {
        if (!modeTouched.current && persisted && persisted.mode !== mode) setModeState(persisted.mode);
    }, [persisted, mode]);
    const setMode = (next: 'server' | 'computer'): void => {
        modeTouched.current = true;
        setModeState(next);
    };
    const installation = useEmbeddingInstallation(
        JSON.stringify([scope, projectId, device?.id, device?.report.root, binding?.bindingId, binding?.instanceId]),
        choices,
        ready,
        persistedInstallation && targetInstallationKey(persistedInstallation),
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
    // Селектор каталога, RAG-вкладки и OpenCodeRAG читают один серверный персист проекта.
    const canPersist = !!projectId && projectRoleLevel(user, projectId) >= 2;
    const payload: IProjectEmbeddingTarget | null =
        mode === 'server'
            ? { mode: 'server', installation: null }
            : value
              ? {
                    mode: 'computer',
                    installation: {
                        deviceId: value.deviceId,
                        assetId: value.assetId,
                        assetKind: value.assetKind,
                        version: value.version,
                        expectedManifest: value.expectedManifest,
                    },
                }
              : null;
    const written = useRef<string | undefined>(undefined);
    const payloadKey = JSON.stringify(payload);
    // Сброс перлиста пишется только при определённом состоянии; офлайн-мост и пересборка не затирают выбор.
    const resettable = mode === 'server' || !!value || ['binding', 'installation', 'selection'].includes(blocker ?? '');
    useEffect(() => {
        if (!projectId || !canPersist || !ready || bridge.error || persisted === undefined || !resettable) return;
        if (written.current === payloadKey) return;
        if (JSON.stringify(persisted) === payloadKey) {
            written.current = payloadKey;
            return;
        }
        written.current = payloadKey;
        void projectEmbeddingApi.saveTarget(projectId, payload).catch(() => {
            written.current = undefined;
        });
    }, [projectId, canPersist, ready, bridge.error, persisted, resettable, payloadKey, payload]);
    return {
        projectId,
        bridge,
        device,
        binding,
        item,
        inspection,
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
