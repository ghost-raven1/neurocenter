import { FeatureButton, useFeatureAvailability } from '../../features/FeatureFlags/FeatureAvailability';
import { Alert, Button, Col, Form, Input, InputNumber, Row, Select, Space, Switch, Typography } from 'antd';
import type { FormInstance } from 'antd';
import type { FC } from 'react';

import type { IMaintenancePolicy } from './maintenancePolicy';

interface IFullBackupFormProps {
    form: FormInstance<IMaintenancePolicy>;
    ready: boolean;
    revision: number | null;
    statusRevision: number | null;
    saving: boolean;
    saveError: string | null;
    onSave: (policy: IMaintenancePolicy) => Promise<void>;
    onUseSavedPolicy: () => void;
}

const weekdays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((label, index) => ({ label, value: index + 1 }));
const clockRules = [
    { required: true, message: 'Укажите время' },
    { pattern: /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/, message: 'Формат ЧЧ:ММ' },
];
const daysRules = [{ required: true, message: 'Выберите дни' }];

/** Форма подключена до первого ответа; до инициализации скрыта атрибутом hidden. */
const FullBackupForm: FC<IFullBackupFormProps> = ({
    form, ready, revision, statusRevision, saving, saveError, onSave, onUseSavedPolicy,
}) => {
    const enabled = Form.useWatch('enabled', form);
    const availability = useFeatureAvailability('project_backups');

    return (
        <Form
            className="maintenance-page__settings" form={form} layout="vertical"
            onFinish={values => { if(availability.enabled || !values.enabled) void onSave(values); }} disabled={saving} hidden={!ready}
            scrollToFirstError={{ block: 'center' }}
        >
            <section className="maintenance-page__form-section" aria-labelledby="maintenance-schedule-title">
                <Typography.Title level={3} id="maintenance-schedule-title">Расписание</Typography.Title>
                <Row gutter={[16, 0]}>
                    <Col xs={24} md={8}>
                        <Form.Item name="enabled" label="Расписание полной копии" valuePropName="checked">
                            <Switch checkedChildren="Включено" unCheckedChildren="Выключено" />
                        </Form.Item>
                    </Col>
                    <Col xs={24} md={8}>
                        <Form.Item name="timeZone" label="Часовой пояс IANA" rules={[{ required: true, message: 'Укажите часовой пояс' }]}>
                            <Input placeholder="Asia/Tomsk" />
                        </Form.Item>
                    </Col>
                    <Col xs={24} md={8}>
                        <Form.Item name={['schedule', 'time']} label="Время начала в выбранном поясе" rules={clockRules}>
                            <Input placeholder="02:00" maxLength={5} />
                        </Form.Item>
                    </Col>
                    <Col span={24}>
                        <Form.Item name={['schedule', 'days']} label="Дни полной копии" rules={daysRules}>
                            <Select mode="multiple" options={weekdays} />
                        </Form.Item>
                    </Col>
                </Row>
            </section>
            <section className="maintenance-page__form-section" aria-labelledby="maintenance-windows-title">
                <Typography.Title level={3} id="maintenance-windows-title">Допустимые окна обслуживания</Typography.Title>
                <Typography.Paragraph type="secondary" className="maintenance-page__section-description">
                    Дни относятся к началу окна. Одинаковые границы означают сутки; конец раньше начала — переход через полночь.
                    Максимальная пауза должна помещаться в окно.
                </Typography.Paragraph>
                <Form.List name="windows">
                    {(fields, { add, remove }) => <>
                        {fields.map(field => (
                            <div className="maintenance-page__window" key={field.key}>
                                <Row gutter={[12, 0]} align="bottom">
                                    <Col xs={24} md={10}>
                                        <Form.Item name={[field.name, 'days']} label="Дни начала окна" rules={daysRules}>
                                            <Select mode="multiple" options={weekdays} />
                                        </Form.Item>
                                    </Col>
                                    <Col xs={12} md={5}>
                                        <Form.Item name={[field.name, 'start']} label="С" rules={clockRules}>
                                            <Input placeholder="01:00" maxLength={5} />
                                        </Form.Item>
                                    </Col>
                                    <Col xs={12} md={5}>
                                        <Form.Item name={[field.name, 'end']} label="До" rules={clockRules}>
                                            <Input placeholder="05:00" maxLength={5} />
                                        </Form.Item>
                                    </Col>
                                    <Col xs={24} md={4} className="maintenance-page__window-action">
                                        <Button
                                            type="link" danger disabled={saving || fields.length === 1}
                                            onClick={() => remove(field.name)} aria-label={`Удалить окно ${field.name + 1}`}
                                        >
                                            Удалить
                                        </Button>
                                    </Col>
                                </Row>
                            </div>
                        ))}
                        <Button
                            className="maintenance-page__add-window" disabled={saving || fields.length >= 7}
                            onClick={() => add({ days: [1, 2, 3, 4, 5, 6, 7], start: '01:00', end: '05:00' })}
                        >
                            Добавить окно
                        </Button>
                    </>}
                </Form.List>
            </section>
            <section className="maintenance-page__form-section" aria-labelledby="maintenance-retention-title">
                <Typography.Title level={3} id="maintenance-retention-title">Хранение и цели восстановления</Typography.Title>
                <Row gutter={[16, 0]}>
                    <Col xs={24} md={8}>
                        <Form.Item name="maxPauseMinutes" label="Максимальная пауза, мин" rules={[{ required: true, message: 'Укажите предел' }]}>
                            <InputNumber min={2} max={1440} precision={0} />
                        </Form.Item>
                    </Col>
                    <Col xs={24} md={8}>
                        <Form.Item name="localCopies" label="Хранить локальных полных комплектов" rules={[{ required: true, message: 'Укажите количество' }]}>
                            <InputNumber min={1} max={100} precision={0} />
                        </Form.Item>
                    </Col>
                    <Col xs={24} md={8}>
                        <Form.Item name="externalRetentionDays" label="Внешнее хранение, дней (цель)" rules={[{ required: true, message: 'Укажите срок' }]}>
                            <InputNumber min={1} max={3650} precision={0} />
                        </Form.Item>
                    </Col>
                    <Col xs={24} md={12}>
                        <Form.Item name="rpoMinutes" label="RPO: допустимый возраст данных, мин" rules={[{ required: true, message: 'Укажите RPO' }]}>
                            <InputNumber min={1} max={10080} precision={0} />
                        </Form.Item>
                    </Col>
                    <Col xs={24} md={12}>
                        <Form.Item name="rtoMinutes" label="RTO: цель восстановления, мин" rules={[{ required: true, message: 'Укажите RTO' }]}>
                            <InputNumber min={1} max={10080} precision={0} />
                        </Form.Item>
                    </Col>
                </Row>
            </section>
            <Alert
                className="maintenance-page__notice" type="info" showIcon
                message="Для работы расписания нужен runner на сервере"
                description="Тик запускается системным таймером раз в минуту. Доступ к S3 задаётся только в закрытом окружении оператора. Внешний retention настраивается политикой хранилища; RTO подтверждается отдельной репетицией восстановления."
            />
            {enabled && <Typography.Paragraph type="secondary">
                Сохранение включает расписание в runner. Работа таймера и доступность S3 подтверждаются журналом запусков ниже.
            </Typography.Paragraph>}
            {statusRevision !== revision && <Alert
                className="maintenance-page__notice" type="warning" showIcon
                message="Другой администратор уже изменил настройки"
                description="Ваш черновик сохранён. Для нового сохранения загрузите сохранённые значения кнопкой ниже."
            />}
            {saveError && <Alert
                className="maintenance-page__notice" type="error" showIcon
                message="Настройки не сохранены" description={saveError}
            />}
            <div className="maintenance-page__form-actions">
                <Space wrap>
                    <FeatureButton features={enabled ? ['project_backups'] : []} type="primary" htmlType="submit" loading={saving} disabled={revision === null}>
                        Сохранить настройки
                    </FeatureButton>
                    <Button disabled={saving} onClick={onUseSavedPolicy}>Загрузить сохранённые значения</Button>
                </Space>
                <Typography.Text type="secondary">Ревизия формы: {revision}</Typography.Text>
            </div>
        </Form>
    );
};

export default FullBackupForm;
