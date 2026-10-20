import { Alert, Form, Select } from 'antd';

/** Multiple commands always require an explicit choice; an empty value never selects the first item. */
export function SourceEntrypointChoice({ candidates, value, onChange, disabled = false, label = 'Файл запуска' }: {
    candidates: string[]; value: string; onChange: (value: string) => void; disabled?: boolean; label?: string;
}) {
    if (candidates.length < 2) return null;
    return <Form.Item label={label} extra="Найдено несколько команд. Выберите ту, которую должен запускать OpenCode.">
        {!value && <Alert type="info" showIcon message="Нужно выбрать команду запуска" />}
        <Select aria-label={label} value={value || undefined} onChange={onChange} disabled={disabled} showSearch
            options={candidates.map(candidate => ({ value: candidate, label: candidate }))} placeholder="Выберите команду запуска" />
    </Form.Item>;
}
