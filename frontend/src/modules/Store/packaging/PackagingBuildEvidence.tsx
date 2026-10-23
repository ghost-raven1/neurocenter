import {Alert, Collapse, Tag, Typography} from 'antd';
import {packagingPlatformLabels} from './platformLabels';
import type {ToolBuild} from './types';

const platformLabel = (value: string): string => packagingPlatformLabels[value.replace(/-gnu$/, '-glibc')] || value;
const stateLabel = {STARTED: 'Выполняется', SUCCEEDED: 'Готово', FAILED: 'Ошибка'};
const diagnosticMessages = (value: unknown): string[] => Array.isArray(value) ? value.flatMap(item => typeof item === 'string' ? [item] : item && typeof item.message === 'string' ? [item.message] : []) : [];

/** A startup receipt proves only its recorded host; other targets remain explicitly untested. */
export function PackagingBuildEvidence({job}: {job?: ToolBuild}) {
    const receipt = job?.runtimeVerification, steps = job?.agentSteps ?? [];
    if (!receipt && !steps.length) return null;
    const latest = steps[steps.length - 1];
    const stopped = job?.state === 'FAILED' || job?.state === 'CANCELLED';
    const terminal = stopped || job?.state === 'SUCCEEDED';
    const stepLabel = (state: keyof typeof stateLabel): string => stopped && state === 'STARTED' ? 'Прервано' : stateLabel[state];
    const labels = ['Рецепт', 'Сборка', 'Проверка запуска', 'Ревью', 'Публикация'];
    const stage = job?.publicationStartedAt || job?.state === 'SUCCEEDED' ? 4 : latest?.stage === 'review' ? 3 : receipt ? 2
        : /запуск|startup|runtime|tools\/list|hooks/i.test(job?.message ?? '') ? 2
        : latest?.stage === 'propose' && latest.state === 'STARTED' ? 0 : 1;
    return <section aria-label="Проверки Упаковщика">
        {!!steps.length && <>
            <ol className="tool-packaging__agent-steps" aria-label="Этапы работы Упаковщика">{labels.map((label, index) => <li key={label} aria-current={!terminal && stage === index ? 'step' : undefined}>{label}{!terminal && index === stage ? ' — текущий этап' : ''}</li>)}</ol>
            {latest && <Typography.Paragraph>Попытка {latest.attempt}: {latest.stage === 'propose' ? 'подготовка рецепта' : 'ревью результата'} · {stepLabel(latest.state)}</Typography.Paragraph>}
        </>}
        {receipt && <Alert showIcon type={receipt.status === 'passed' ? 'success' : receipt.status === 'cancelled' ? 'info' : 'error'} message={receipt.status === 'cancelled' ? 'Проверка запуска отменена' : receipt.status === 'failed' ? 'Проверка запуска не пройдена' : receipt.testedTarget ? `Запуск проверен: ${platformLabel(receipt.testedTarget)}` : 'Проверка пакета завершена'}
            description={<>
                {!!job?.runtimeVerificationAttempt && <div>Сохранённая проверка: попытка {job.runtimeVerificationAttempt}. Результат относится к кандидату этой попытки.</div>}
                <div>Сервер проверки: {platformLabel(receipt.hostTarget)}. Завершено: {receipt.finishedAt}.</div>
                <div>Обнаружено инструментов: {receipt.counts.tools}; hooks плагина: {receipt.counts.pluginHooks}.</div>
                {!receipt.testedTarget && <div>Запуск на целевой платформе не подтверждён.</div>}
                {!receipt.isolation.osEnforced && <div>Изоляция средствами ОС не подтверждена.</div>}
                {receipt.diagnostics.map((item, index) => <div key={`${item.code}:${index}`}>{item.message}</div>)}
                {!!receipt.untestedTargets.length && <div>Запуск не проверялся на: {receipt.untestedTargets.map(platformLabel).join(', ')}. Проверка на сервере не подтверждает работу на этих платформах.</div>}
            </>}/>}
        {!!steps.length && <Collapse ghost className="tool-packaging__details"><Collapse.Panel header="Рецепт и ревью по попыткам" key="agent">
            {steps.map((step, index) => <div key={`${step.attempt}:${step.stage}:${index}`}><Tag>Попытка {step.attempt}</Tag><Typography.Text strong>{step.stage === 'propose' ? 'Рецепт' : 'Ревью'}: {stepLabel(step.state)}</Typography.Text>{diagnosticMessages(step.diagnostics).map((message, diagnostic) => <Typography.Paragraph key={diagnostic}>{message}</Typography.Paragraph>)}</div>)}
        </Collapse.Panel></Collapse>}
    </section>;
}
