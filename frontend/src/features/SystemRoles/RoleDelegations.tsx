import { Alert, Typography } from 'antd';
import { roleName, type RoleResult } from './types';
import { RoleFindingEvidence, RoleProjectContextReceiptView } from './RoleProjectContext';
import {RoleAnswer} from './RoleGuidance';

/** Independent answers remain inspectable even when another role or the final summary is unavailable. */
export function RoleDelegations({ delegations, diagnosticIds = [] }: { delegations: NonNullable<RoleResult['delegations']>; diagnosticIds?: string[] }): JSX.Element {
    return <section aria-label="Ответы системных агентов"><Typography.Title level={5}>Результаты делегирования</Typography.Title>
        <Typography.Paragraph type="secondary">Координатор собирает рекомендации. Применение изменений выполняется отдельным подтверждённым действием.</Typography.Paragraph>
        {delegations.map(item => <details key={item.roleId} open><summary>{roleName(item.roleId)} · {item.state === 'succeeded' ? 'ответ получен' : 'ответ недоступен'}</summary>
            {item.message && <Alert type="warning" showIcon message={item.message} />}
            {item.result && <><RoleAnswer result={item.result} />
                {item.result.findings.map((finding, index) => <Typography.Paragraph key={index}>{finding.detail}<br /><RoleFindingEvidence evidenceId={finding.evidenceId} context={item.result?.projectContext} guidance={item.result?.guidance} diagnosticIds={diagnosticIds} /></Typography.Paragraph>)}
                <RoleProjectContextReceiptView context={item.result.projectContext} />
                {!!item.result.nextSteps.length && <ul>{item.result.nextSteps.map((step, index) => <li key={index}>{step}</li>)}</ul>}
                {item.result.changes.map(change => <div key={change.targetKey}><Typography.Text strong>{change.targetKey}</Typography.Text><Typography.Paragraph>{change.explanation}</Typography.Paragraph>
                    <pre>{change.replacement}</pre><Typography.Paragraph copyable={{ text: change.replacement }}>Скопировать предложение</Typography.Paragraph></div>)}
            </>}
        </details>)}
    </section>;
}
