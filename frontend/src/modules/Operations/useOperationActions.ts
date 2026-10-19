import { Modal, message } from 'antd';
import { createElement, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSelector, useStore } from 'react-redux';

import type { IOperation } from '../../core/api/interfaces';
import { bridgeApi } from '../../features/McpBridge/api';
import type { RootState } from '../../store';

import { operationActionScope } from './operationActions';
import { createOperationActionsController } from './operationActionsController';

interface IOperationActionsOptions {
    reload: () => Promise<void>;
    enabled?: boolean;
}

/** Подтверждения и уведомления прекращаются при выходе или смене назначений пользователя. */
export function useOperationActions({ reload, enabled = true }: IOperationActionsOptions) {
    const store = useStore<RootState>();
    const scope = useSelector((state: RootState) => operationActionScope(state.userBlock.user));
    const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
    const cancelTitleId = useId();
    const cancelSequence = useRef(0);
    const reloadRef = useRef(reload);
    reloadRef.current = reload;

    const controller = useMemo(() => createOperationActionsController({
        getUser: () => store.getState().userBlock.user,
        retry: bridgeApi.retry,
        cancel: bridgeApi.cancel,
        reload: () => reloadRef.current(),
        confirmCancel: (onOk, onCancel) => {
            const titleId = `${cancelTitleId}-${++cancelSequence.current}`;
            return Modal.confirm({
                title: createElement('span', { id: titleId, ref: (element: HTMLSpanElement | null): void => {
                    element?.closest('[role="dialog"]')?.setAttribute('aria-labelledby', titleId);
                } }, 'Отменить задание в очереди?'),
                content: 'Отмена доступна, пока мост не начал работу. Уже выполняющееся задание остановить здесь нельзя.',
                okText: 'Отменить задание',
                cancelText: 'Вернуться',
                okButtonProps: { danger: true },
                onOk,
                onCancel,
            });
        },
        success: text => { void message.success(text); },
        error: text => { void message.error(text); },
        onBusyChange: setBusy,
        requestKey: () => crypto.randomUUID(),
    }), [store, scope, enabled, cancelTitleId]);

    useLayoutEffect(() => {
        if (enabled) { controller.activate(); }
        else { setBusy(new Set()); }
        return () => controller.dispose();
    }, [controller, enabled]);

    return {
        isBusy: (operationId: string): boolean => busy.has(operationId),
        retry: (operation: IOperation): void => { void controller.retry(operation); },
        cancel: controller.cancel,
    };
}
