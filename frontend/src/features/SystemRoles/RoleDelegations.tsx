import { Alert, Typography } from 'antd';
import { roleName, type RoleResult } from './types';

/** Independent answers remain inspectable even when another role or the final summary is unavailable. */
export function RoleDelegations({ delegations }: { delegations: NonNullable<RoleResult['delegations']> }): JSX.Element {
    return <section aria-label="Ответы системных агентов"><Typography.Title level={5}>Результаты делегирования</Typography.Title>
        <Typography.Paragraph type="secondary">Координатор собирает рекомендации. Применение изменений выполняется отдельным подтверждённым действием.</Typography.Paragraph>
        {delegations.map(item => <details key={item.roleId} open><summary>{roleName(item.roleId)} · {item.state === 'succeeded' ? 'ответ получен' : 'ответ недоступен'}</summary>
            {item.message && <Alert type="warning" showIcon message={item.message} />}
            {item.result && <><Typography.Paragraph>{item.result.summary}</Typography.Paragraph>
                {item.result.findings.map((finding, index) => <Typography.Paragraph key={index}>{finding.detail} · Основание: {finding.evidenceId}</Typography.Paragraph>)}
                {!!item.result.nextSteps.length && <ul>{item.result.nextSteps.map((step, index) => <li key={index}>{step}</li>)}</ul>}
                {item.result.changes.map(change => <div key={change.targetKey}><Typography.Text strong>{change.targetKey}</Typography.Text><Typography.Paragraph>{change.explanation}</Typography.Paragraph>
                    <pre>{change.replacement}</pre><Typography.Paragraph copyable={{ text: change.replacement }}>Скопировать предложение</Typography.Paragraph></div>)}
            </>}
        </details>)}
    </section>;
}
