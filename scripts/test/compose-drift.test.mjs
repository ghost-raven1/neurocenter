import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dump as dumpYaml } from 'js-yaml';
import {
    MODEL_FILE,
    deadEnvironment,
    loadEnvironmentModel,
    loadProductionCompose,
    parseComposeDocument,
    parseSecretNames,
    requiredEnvironmentDrift,
    structuralDrift,
} from '../production/environment-model.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Временная копия production compose (+overlay) и модели: мутации применяются
 * к файлам, дальше идёт обычный путь «файл → YAML → сверка», как в реальном сьюте.
 */
async function fixture(t, { mutateCompose, mutateModel } = {}) {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'nc compose drift '));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const model = await loadEnvironmentModel(root);
    await fs.mkdir(path.join(directory, 'deploy/production'), { recursive: true });
    await fs.copyFile(path.join(root, MODEL_FILE), path.join(directory, MODEL_FILE));
    for (const file of [model.compose.base, ...model.compose.overlays]) {
        await fs.copyFile(path.join(root, file), path.join(directory, file));
    }
    if (mutateCompose) {
        for (const [file, mutate] of Object.entries(mutateCompose)) {
            const full = path.join(directory, file);
            const document = parseComposeDocument(await fs.readFile(full, 'utf8'));
            mutate(document);
            await fs.writeFile(full, dumpYaml(document));
        }
    }
    if (mutateModel) {
        const modelFile = path.join(directory, MODEL_FILE);
        const modified = JSON.parse(await fs.readFile(modelFile, 'utf8'));
        mutateModel(modified);
        await fs.writeFile(modelFile, JSON.stringify(modified));
    }
    return {
        directory,
        /** Сверка на файлах fixture: compose из каталога, код — из реального checkout. */
        report: async (modelFile = MODEL_FILE) => {
            const checked = await loadEnvironmentModel(directory, modelFile);
            const services = await loadProductionCompose(directory, checked);
            const secretNames = await parseSecretNames(root);
            return {
                checked,
                services,
                drift: structuralDrift(checked, services),
                dead: deadEnvironment(checked, services, { root, secretNames }),
                required: requiredEnvironmentDrift(checked, services, { root, secretNames }),
            };
        },
    };
}

test('production compose совпадает с моделью окружения и не содержит dead-env (включая overlay)', async (t) => {
    const f = await fixture(t);
    const { checked, services, drift, dead, required } = await f.report();
    assert.deepEqual(drift, []);
    assert.deepEqual(dead.dead, []);
    assert.deepEqual(dead.noteErrors, []);
    // Все 12 сервисов production-стека охвачены, merge-якоря и overlay развёрнуты.
    assert.deepEqual(Object.keys(services).sort(), Object.keys(checked.services).sort());
    assert.equal(Object.keys(services).length, 12);
    const totalEnv = Object.values(services).reduce((sum, service) => sum + Object.keys(service.env).length, 0);
    assert.ok(totalEnv >= 80, `ожидалось не менее 80 env, получено ${totalEnv}`);
    // Production-контракт required env (D2) закрыт: 0 missing (code→compose), 0 phantom, 0 noteErrors.
    assert.deepEqual(required.missing, []);
    assert.deepEqual(required.phantom, []);
    assert.deepEqual(required.noteErrors, []);
    const requiredTotal = Object.values(checked.services).reduce(
        (sum, service) => sum + Object.keys(service.requiredEnv).length,
        0,
    );
    assert.equal(
        requiredTotal,
        36,
        'начальный набор requiredEnv (D2): изменение набора — только осознанной правкой этого теста',
    );
});

test('merge-ключи <<: *service / <<: *runtime развёрнуты до сверки env', async (t) => {
    const f = await fixture(t);
    const { services, dead } = await f.report();
    // Значения из якоря x-runtime попали в env каждого node-сервиса.
    for (const name of [
        'catalog-service',
        'feature-flags-service',
        'skills-service',
        'rag-sync-service',
        'oauth2-bridge',
        'api-gateway',
    ]) {
        assert.equal(services[name].env.PANEL_URL, '${PANEL_URL:?Заполните PANEL_URL}', name);
        assert.equal(services[name].env.BIND_HOST, '0.0.0.0', name);
    }
    // Сети из якоря x-service; override фронта сохранён.
    assert.deepEqual(services.postgres.networks, ['backend']);
    assert.deepEqual(services.frontend.networks, ['backend', 'edge']);
    assert.equal(services['capacity-collector'].networkMode, 'none');
    // Overlay'и наложены на базовый стек.
    assert.equal(
        services['catalog-service'].env.CHAT_S3_ENDPOINT,
        '${CHAT_S3_ENDPOINT:?Configure Ceph RGW HTTPS endpoint}',
    );
    assert.ok(services['catalog-service'].secrets.includes('chat_s3_access_key'));
    assert.equal(services['catalog-service'].env.RESTORE_RUNNER_TOKEN_FILE, '/run/secrets/restore_runner_token');
    assert.equal(services['catalog-service'].ports.length, 1);
    // Якорные env не считаются dead: они развёрнуты и читаются кодом.
    assert.deepEqual(dead.dead, []);
});

test('env в compose, не читаемый кодом, ловится с именем переменной и сервиса', async (t) => {
    const f = await fixture(t, {
        mutateCompose: {
            'compose.production.yml': (document) => {
                document.services['api-gateway'].environment.FAKE_DEAD_VARIABLE = '1';
            },
        },
    });
    const { drift, dead } = await f.report();
    assert.deepEqual(
        drift.map((entry) => `${entry.service}.${entry.field}`),
        ['api-gateway.env'],
    );
    assert.deepEqual(dead.dead, [{ service: 'api-gateway', env: 'FAKE_DEAD_VARIABLE' }]);
});

test('dead-env в production overlay (chat-storage/web-restore) ловится с именем переменной', async (t) => {
    const f = await fixture(t, {
        mutateCompose: {
            'compose.chat-storage.yml': (document) => {
                document.services['catalog-service'].environment.CHAT_S3_FAKE_REGION = 'fake';
            },
        },
    });
    const { drift, dead } = await f.report();
    assert.deepEqual(
        drift.map((entry) => `${entry.service}.${entry.field}`),
        ['catalog-service.env'],
    );
    assert.deepEqual(dead.dead, [{ service: 'catalog-service', env: 'CHAT_S3_FAKE_REGION' }]);
});

test('расхождение модели с compose (mem/cpus/pids, secrets, ports) указывается как service.field', async (t) => {
    const f = await fixture(t, {
        mutateModel: (model) => {
            model.services['catalog-service'].memLimit = '1g';
            model.services['skills-service'].cpus = 2;
            model.services['feature-flags-service'].pidsLimit = 256;
            model.services.postgres.secrets = [];
            model.services.frontend.ports = [{ target: 8080, published: 81, hostIp: null, protocol: null }];
            model.services['model-runtime'].capDrop = [];
        },
    });
    const { drift } = await f.report();
    assert.deepEqual(
        drift.map((entry) => `${entry.service}.${entry.field}`).sort(),
        [
            'catalog-service.memLimit',
            'feature-flags-service.pidsLimit',
            'frontend.ports',
            'model-runtime.capDrop',
            'postgres.secrets',
            'skills-service.cpus',
        ].sort(),
    );
    for (const entry of drift) {
        assert.notDeepEqual(entry.model, entry.compose, entry.service + '.' + entry.field);
    }
});

test('сервис только в compose (или только в модели) — структурный drift', async (t) => {
    const f = await fixture(t, {
        mutateModel: (model) => {
            model.services['extra-service'] = structuredClone(model.services['feature-flags-service']);
            delete model.services['skills-service'];
        },
    });
    const { drift } = await f.report();
    assert.deepEqual(drift.map((entry) => `${entry.service}.${entry.field}`).sort(), [
        'extra-service.(service)',
        'skills-service.(service)',
    ]);
});

test('external/consumedBy-переменная без пометки в модели видна как dead-env', async (t) => {
    const f = await fixture(t, {
        mutateModel: (model) => {
            delete model.services.frontend.envNotes;
            delete model.services['model-runtime'].envNotes.OLLAMA_HOST;
            delete model.services['api-gateway'].envNotes;
        },
    });
    const { dead } = await f.report();
    assert.deepEqual(
        dead.dead.sort((a, b) => (a.service + a.env).localeCompare(b.service + b.env)),
        [
            { service: 'frontend', env: 'NEUROCENTER_HOST' },
            { service: 'model-runtime', env: 'OLLAMA_HOST' },
        ],
    );
    assert.deepEqual(dead.noteErrors, []);
});

test('некорректная пометка в модели не прощается: external для своего образа и consumedBy без $NAME в command', async (t) => {
    const f = await fixture(t, {
        mutateModel: (model) => {
            model.services['api-gateway'].envNotes = {
                NODE_TLS_REJECT_UNAUTHORIZED: { external: 'чужой образ' },
            };
            model.services.frontend.envNotes = { NEUROCENTER_HOST: { consumedBy: 'command' } };
        },
    });
    const { dead } = await f.report();
    assert.deepEqual(dead.noteErrors, [
        {
            service: 'api-gateway',
            env: 'NODE_TLS_REJECT_UNAUTHORIZED',
            error: 'external: допустима только для стороннего образа, у сервиса образ neurocenter/api-gateway:${NEUROCENTER_RELEASE:?Заполните метку релиза}',
        },
    ]);
    assert.deepEqual(dead.dead, []);
});

test('пометка consumedBy:command требует $NAME в command сервиса', async (t) => {
    const f = await fixture(t, {
        mutateCompose: {
            'compose.production.yml': (document) => {
                document.services.frontend.command = ['/bin/sh', '-ec', 'nginx -g "daemon off;"'];
            },
        },
        mutateModel: (model) => {
            // Без пометки OLLAMA_HOST остаётся ровно один dead-env — список изолирован.
            delete model.services['model-runtime'].envNotes.OLLAMA_HOST;
        },
    });
    const { dead } = await f.report();
    assert.equal(dead.noteErrors.length, 1);
    assert.equal(dead.noteErrors[0].service, 'frontend');
    assert.equal(dead.noteErrors[0].env, 'NEUROCENTER_HOST');
    assert.match(dead.noteErrors[0].error, /\$NEUROCENTER_HOST/);
    assert.deepEqual(dead.dead, [{ service: 'model-runtime', env: 'OLLAMA_HOST' }]);
});

test('required env из модели обязан быть в production compose (H5: BRIDGE_TEMPLATES_DIR)', async (t) => {
    const f = await fixture(t, {
        mutateCompose: {
            'compose.production.yml': (document) => {
                delete document.services['api-gateway'].environment.BRIDGE_TEMPLATES_DIR;
            },
        },
    });
    const { drift, required } = await f.report();
    // Модель требует переменную, compose её не несёт: структурный drift + missing с именем сервиса.
    assert.ok(drift.some((entry) => entry.service === 'api-gateway' && entry.field === 'env'));
    assert.deepEqual(required.missing, [{ service: 'api-gateway', env: 'BRIDGE_TEMPLATES_DIR' }]);
    assert.deepEqual(required.phantom, []);
    assert.deepEqual(required.noteErrors, []);
});

test('required env, удалённый из compose (PANEL_URL), фэйлит по каждому сервису, где он объявлен', async (t) => {
    const f = await fixture(t, {
        mutateCompose: {
            // Fixture разворачивает merge-ключи до мутации: PANEL_URL уже скопирован в env каждого node-сервиса.
            'compose.production.yml': (document) => {
                for (const name of [
                    'api-gateway',
                    'catalog-service',
                    'feature-flags-service',
                    'oauth2-bridge',
                    'rag-sync-service',
                    'skills-service',
                ]) {
                    delete document.services[name].environment.PANEL_URL;
                }
            },
        },
    });
    const { required } = await f.report();
    const byName = (a, b) => (a.service + a.env).localeCompare(b.service + b.env);
    assert.deepEqual(
        [...required.missing].sort(byName),
        [
            'api-gateway',
            'catalog-service',
            'feature-flags-service',
            'oauth2-bridge',
            'rag-sync-service',
            'skills-service',
        ]
            .map((service) => ({ service, env: 'PANEL_URL' }))
            .sort(byName),
    );
    assert.deepEqual(required.phantom, []);
});

test('phantom required env: имя не во env сервиса — модель невалидна; не читаемое кодом — phantom + dead-env', async (t) => {
    const f1 = await fixture(t, {
        mutateModel: (model) => {
            model.services['api-gateway'].requiredEnv.GHOST_REQUIRED = 'причина';
        },
    });
    await assert.rejects(f1.report(), /GHOST_REQUIRED/);

    const f2 = await fixture(t, {
        mutateCompose: {
            'compose.production.yml': (document) => {
                document.services['api-gateway'].environment.PHANTOM_REQUIRED_ENV = '1';
            },
        },
        mutateModel: (model) => {
            model.services['api-gateway'].env.PHANTOM_REQUIRED_ENV = '1';
            model.services['api-gateway'].requiredEnv.PHANTOM_REQUIRED_ENV = 'причина';
        },
    });
    const { drift, dead, required } = await f2.report();
    assert.deepEqual(drift, []);
    assert.deepEqual(required.missing, []);
    assert.deepEqual(required.phantom, [{ service: 'api-gateway', env: 'PHANTOM_REQUIRED_ENV', reason: 'причина' }]);
    // Композиция направлений (D1): phantom-имя одновременно видно как dead-env (compose→code, 1.2).
    assert.deepEqual(dead.dead, [{ service: 'api-gateway', env: 'PHANTOM_REQUIRED_ENV' }]);
});

test('requiredEnv без причины, без поля или с переменными у сервиса без codeRoots не проходит валидацию формы', async (t) => {
    const f1 = await fixture(t, {
        mutateModel: (model) => {
            model.services['api-gateway'].requiredEnv.NODE_ENV = '   ';
        },
    });
    await assert.rejects(f1.report(), /api-gateway\.requiredEnv\.NODE_ENV/);

    const f2 = await fixture(t, {
        mutateModel: (model) => {
            delete model.services.frontend.requiredEnv;
        },
    });
    await assert.rejects(f2.report(), /frontend\.requiredEnv/);

    const f3 = await fixture(t, {
        mutateModel: (model) => {
            model.services.postgres.requiredEnv.POSTGRES_USER = 'образ читает';
        },
    });
    await assert.rejects(f3.report(), /postgres\.requiredEnv/);
});

test('возврат BRIDGE_DIST в production compose ловится как dead-env (направление 1.2)', async (t) => {
    const f = await fixture(t, {
        mutateCompose: {
            'compose.production.yml': (document) => {
                document.services['api-gateway'].environment.BRIDGE_DIST = '/app/bridge-dist';
            },
        },
    });
    const { dead, required } = await f.report();
    assert.deepEqual(dead.dead, [{ service: 'api-gateway', env: 'BRIDGE_DIST' }]);
    assert.deepEqual(required.missing, []);
    assert.deepEqual(required.phantom, []);
});
