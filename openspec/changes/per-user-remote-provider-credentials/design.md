# Design

## Context

Текущая RemoteConnectionRepository хранит shared stored/env credential в версии model_remote_connections. Inference attribution уже проходит через ModelUsageContext. HTTP клиент сохраняет существующую проверку URL и redirect:error. См. proposal.md о мотивации.

## Goals / Non-Goals

**Goals:** короткая отдельная SQL lease на актуальный ключ и ACL после rate/reserve, безопасный точный повтор, компактный Ant Design UI.

**Non-Goals:** импорт auth.json OpenCode, новые провайдерские протоколы, передача серверных ключей на мост, перестройка quota ledger или моделей.

## Decisions

- Provider identity вычисляется сервером из модели, runtime и нормализованного URL. Поэтому изменение параметров генерации не требует нового ключа, а изменение получателя не переносит прежний ключ.
- Nullable auth_mode добавляется к connection. Legacy none интерпретируется как none, legacy stored/env — required; ciphertext не мигрирует к пользователю.
- Личный current row содержит ревизию и ciphertext либо tombstone. Отдельная квитанция содержит только безопасные метаданные. Бессрочная история удалённых личных ciphertext не создаётся.
- Существующий AES-GCM используется с отдельным namespace AAD пользователя/провайдера/ревизии. Отпечаток запроса с ключом вычисляется HMAC, plaintext не попадает в журнал.
- Общая logical connection advisory fence блокирует вставку новой версии, а owner/provider fence защищает и случай отсутствующей строки. Отдельный ограниченный pool держит share locks только между последней admission проверкой, claimQuota и literal fetch; освобождение начинается сразу после вызова fetch, не ждёт ответа модели.
- Обрыв SQL-сессии, timeout и отмена немедленно инвалидируют lease. Повторная синхронная проверка после claimQuota не позволяет отправить расшифрованный ключ после потери блокировок; unused reserve освобождается по прежнему контракту.
- Fresh ACL использует существующий общий барьер изменения ролей и проверяет пользователя, активную роль, проект и назначение модели. В отсутствие trusted actor нет fallback.
- Смена личного ключа не изменяет общую модель. Ошибки персонального inference не записываются в общую provider-health строку.

## Risks / Trade-offs

- SQL lease может отказать при contention → ограниченные checkout/lock/query deadlines, отказ до wire и сохранённый retry.
- Сбой после COMMIT → masked receipt по прежнему UUID; клиент не считает 403 доказательством отсутствия записи.
- Исторические общие секреты сохраняются → явно помечены legacy, не исполняются новым dispatcher.

## Migration Plan

Миграция 51 добавляет личные строки и квитанции, auth_mode; новые feature/API контракты публикуются вместе с UI. Проверки на отдельном PG и причинные transport fixtures выполняются до Main. Принятые личные записи не удаляются при rollback; откат runtime требует явного решения о несовместимом dispatcher.
