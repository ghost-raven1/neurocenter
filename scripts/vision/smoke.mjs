#!/usr/bin/env node
/** Проверяет OCR и восприятие цвета двумя собственными PNG через native и OpenAI API. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { configuration } from '../embedding/config.mjs';
import { visionChat, observationQuestion, observationSchema } from './client.mjs';
import { visionFixture } from './image-fixture.mjs';

const { values } = parseArgs({ options: {
    output: { type: 'string' }, summary: { type: 'string' }, 'timeout-ms': { type: 'string' }, help: { type: 'boolean' },
} });
if (values.help) {
    console.log('node scripts/vision/smoke.mjs [--output output/vision] [--summary .run/vision/smoke.json] [--timeout-ms 600000]');
    process.exit(0);
}
const config = configuration(process.env, undefined, 'vision');
const timeoutMs = Number(values['timeout-ms'] ?? 600_000);
assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 10_000 && timeoutMs <= 1_800_000, 'timeout-ms: целое число от 10000 до 1800000.');
const directory = path.resolve(values.output ?? path.join(config.root, 'output/vision'));
const summaryFile = path.resolve(values.summary ?? path.join(config.root, '.run/vision/smoke.json'));
const deadline = Date.now() + timeoutMs;
const fixtures = [
    { id: 'a', expected: { number: '42', color: 'red' } },
    { id: 'b', expected: { number: '17', color: 'blue' } },
].map(fixture => {
    const image = visionFixture(fixture.expected);
    return { ...fixture, image, sha256: createHash('sha256').update(image).digest('hex'), filename: `fixture-${fixture.id}.png` };
});
const report = {
    status: 'running', startedAt: new Date().toISOString(), model: config.lock.model,
    manifestSha256: config.lock.manifestSha256, runtimeImage: config.lock.image, endpoint: config.baseUrl,
    platform: process.platform, architecture: process.arch, node: process.versions.node,
    question: observationQuestion, schema: observationSchema, timeoutMs, checks: [], cases: [],
    fixtures: fixtures.map(({ id, expected, sha256, filename, image }) => ({ id, filename, expected, sha256, bytes: image.length })),
    syntheticImagesOnly: true, homeReassigned: false,
};

/** Сохраняет ответ до проверки; ожидаемые признаки никогда не добавляются в вопрос модели. */
async function observe(fixture, protocol) {
    const remaining = deadline - Date.now();
    assert.ok(remaining >= 1000, 'Общий срок vision smoke истёк.');
    const entry = { fixture: fixture.id, protocol, passed: false, startedAt: new Date().toISOString() };
    report.cases.push(entry);
    process.stderr.write(`Проверяем ${protocol}: собственное изображение ${fixture.id.toUpperCase()}…\n`);
    const started = Date.now();
    const result = await visionChat(config, { image: fixture.image, question: observationQuestion,
        format: observationSchema, protocol, maxTokens: 256, timeout: Math.min(300_000, remaining) });
    entry.durationMs = Date.now() - started; entry.result = result;
    assert.equal(result.truncated, false, 'Ответ оборван по лимиту токенов.');
    const observation = JSON.parse(result.text);
    entry.observation = observation;
    assert.deepEqual(Object.keys(observation).sort(), ['color', 'number'], 'Ответ должен содержать только number и color.');
    assert.deepEqual(observation, fixture.expected, `Не распознаны цифры или цвет собственного изображения ${fixture.id.toUpperCase()}.`);
    entry.passed = true;
    return observation;
}

try {
    assert.notEqual(fixtures[0].sha256, fixtures[1].sha256, 'Контрольные изображения должны различаться.');
    assert.ok(!/\d/.test(observationQuestion), 'Вопрос не должен подсказывать ожидаемые цифры.');
    assert.ok(!/\b(?:red|blue|green)\b/i.test(observationQuestion), 'Вопрос не должен подсказывать ожидаемый цвет.');
    await fs.mkdir(directory, { recursive: true });
    for (const fixture of fixtures) await fs.writeFile(path.join(directory, fixture.filename), fixture.image);

    const first = await observe(fixtures[0], 'ollama');
    report.checks.push('Native API прочитал цифры и цвет изображения A без ответа в вопросе');
    const second = await observe(fixtures[1], 'ollama');
    report.checks.push('Native API прочитал цифры и цвет контрольного изображения B');
    assert.notEqual(first.number, second.number); assert.notEqual(first.color, second.color);
    report.checks.push('При неизменном вопросе замена PNG меняет оба признака ответа');
    const compatible = await observe(fixtures[0], 'openai');
    assert.deepEqual(compatible, first);
    report.checks.push('OpenAI-совместимый API с data URL воспроизводит правильное наблюдение изображения A');
    report.status = 'passed';
} catch (error) {
    report.status = 'failed'; report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1;
} finally {
    report.finishedAt = new Date().toISOString();
    const summary = { ...report, cases: report.cases.map(({ result, ...entry }) => ({ ...entry,
        model: result?.model, truncated: result?.truncated })), reportFile: path.join(directory, 'smoke.json') };
    await fs.mkdir(directory, { recursive: true });
    await fs.mkdir(path.dirname(summaryFile), { recursive: true });
    await fs.writeFile(path.join(directory, 'smoke.json'), JSON.stringify(report, null, 2) + '\n');
    await fs.writeFile(summaryFile, JSON.stringify(summary, null, 2) + '\n');
    console.log(JSON.stringify(summary, null, 2));
}
