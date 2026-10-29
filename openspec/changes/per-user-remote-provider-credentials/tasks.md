# Tasks

## 1. Персональное хранение и контракт
- [x] 1.1 Добавить миграцию 51 и проверку схемы; отдельный PG подтверждает сохранение legacy ciphertext и shape текущих личных строк.
- [x] 1.2 Реализовать masked personal API, CAS и request receipts; проверки A/B, encryption AAD, DELETE ciphertext, lost ACK и 403-after-COMMIT.

## 2. Исполнение
- [x] 2.1 Подключить authMode и отсутствие shared/env fallback; transport tests подтверждают none/optional/required и независимость model pin/личной ошибки.
- [x] 2.2 Реализовать ограниченную lease перед claimQuota и literal fetch; причинные тесты отзыва, смены URL, cancel, потери SQL-сессии и освобождения unused reserve.
- [x] 2.3 Дополнить точного trusted actor в пропущенных маршрутах; тесты model/project chats, roles, research, embeddings и agents не допускают missing actor fallback.

## 3. Интерфейс и интеграция
- [x] 3.1 Добавить MyAccess UI и provider authMode; DOM tests сохраняют секрет в памяти при ошибке, изолируют владельцев и восстанавливают квитанции без plaintext GET.
- [x] 3.2 Согласовать флаг и OpenAPI, выполнить production TypeScript и затронутые проверки, независимое source review; сохранить точные результаты.
- [x] 3.3 Выполнить desktop браузерную приёмку на отдельном стенде: два пользователя, загрузка настроек, ввод/удаление ключа, ошибки и recovery; без платных вызовов и Main DB. Свидетельства: docs/reports/personal-provider-acceptance-2026-10-29.md.
