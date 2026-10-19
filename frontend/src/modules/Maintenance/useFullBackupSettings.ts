import { Form, message } from 'antd';
import { useLayoutEffect, useMemo, useState } from 'react';

import base from '../../core/api/base';

import { createFullBackupSettingsController, initialFullBackupSettingsState } from './fullBackupSettingsController';
import type { IMaintenancePolicy, IMaintenancePolicyResult, IMaintenanceStatus } from './maintenancePolicy';

/** Hook принадлежит одному аккаунту: смена владельца пересоздаёт компонент с формой. */
export function useFullBackupSettings() {
    const [form] = Form.useForm<IMaintenancePolicy>();
    const [state, setState] = useState(initialFullBackupSettingsState);
    const controller = useMemo(() => createFullBackupSettingsController({
        read: async () => (await base.get<IMaintenanceStatus>('/api/maintenance/policy')).data,
        write: async (revision, policy) => (await base.patch<IMaintenancePolicyResult>(
            '/api/maintenance/policy', { expectedRevision: revision, policy },
        )).data,
        onChange: setState,
        onPolicy: policy => {
            form.resetFields();
            form.setFieldsValue(policy);
        },
        onSaved: () => { void message.success('Настройки сохранены и записаны в аудит'); },
        onAccessDenied: () => form.resetFields(),
    }), [form]);

    useLayoutEffect(() => {
        controller.activate();
        void controller.refresh();
        const timer = setInterval(() => void controller.refresh(), 30000);
        return () => {
            clearInterval(timer);
            controller.dispose();
        };
    }, [controller]);

    return {
        ...state,
        form,
        refresh: controller.refresh,
        save: controller.save,
        useSavedPolicy: controller.useSavedPolicy,
    };
}
