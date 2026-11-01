# OpenCode provider version evidence

Read-only refs verified 2026-11-01 with git ls-remote: V1 1.14.48 = `4d8ac17c263c0e58fb99c25cc636684dffb45a50`; V2 2.1.2 = `a517687fde98a7329ada3ae644a01a9fc6c4e99e`. This is researched source evidence, not native acceptance or permission to widen the editor guard. The user-reported 2.2.2 is not covered by this pin. A separate local PATH observation returned 1.19.5.

Первичные источники закреплённого V2:
- [Credentials и SQLite](https://github.com/anomalyco/opencode/blob/a517687fde98a7329ada3ae644a01a9fc6c4e99e/services/www/src/docs/content/cli/providers.mdx): legacy auth.json импортируется при миграции; новые credentials сохраняет сервер в SQLite.
- [Код импорта legacy credentials](https://github.com/anomalyco/opencode/blob/a517687fde98a7329ada3ae644a01a9fc6c4e99e/packages/core/src/database/migration/20260805200742_import_legacy_credentials.ts).
- [Совместимость конфигурации V1/V2](https://github.com/anomalyco/opencode/blob/a517687fde98a7329ada3ae644a01a9fc6c4e99e/services/www/src/docs/content/migrate-v1.mdx): поддержанный V1 нормализуется в памяти; нативный V2 использует providers/settings/package. Это не основание переписывать файлы пользователя.
- [CLI settings](https://github.com/anomalyco/opencode/blob/a517687fde98a7329ada3ae644a01a9fc6c4e99e/services/www/src/docs/content/cli/config.mdx): cli.json относится к клиенту, не заменяет серверные настройки провайдеров.

Будущий V2 adapter — отдельный catalog-actionable-workflows2.3 за capability/флагом и native acceptance. Его inventory MUST не пересылать [credential.list value](https://github.com/anomalyco/opencode/blob/a517687fde98a7329ada3ae644a01a9fc6c4e99e/packages/server/src/handlers/credential.ts), содержащий credentials. Наличие metadata и ответ модели остаются разными свидетельствами.
