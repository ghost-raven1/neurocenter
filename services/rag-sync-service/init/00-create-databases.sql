-- Создаёт БД catalog (fresh-том Postgres).
-- Изначальный скрипт docker-entrypoint запускается от ${POSTGRES_DB} (rag) как
-- superuser. Остальные БД создаём здесь и вешаем pgvector.
CREATE DATABASE catalog;

\c catalog
CREATE EXTENSION IF NOT EXISTS vector;

\c rag
