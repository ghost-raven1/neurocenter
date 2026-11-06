#!/usr/bin/env bash
# AD-15: загрузка 0 pending-тарболов на машине с доступом к npmjs.
# Самодостаточен: bash + curl + sha512sum (или shasum). Результат — каталог out/<path>.
# Затем в checkout проекта: node scripts/supply/vendor.mjs --add out
set -euo pipefail
OUT=${1:-out}
mkdir -p "$OUT"
digest() { # $1=алгоритм $2=файл -> hex
    if [ "$1" = "sha512" ]; then
        if command -v sha512sum >/dev/null 2>&1; then sha512sum "$2" | cut -d' ' -f1
        else shasum -a 512 "$2" | cut -d' ' -f1; fi
    else
        if command -v sha1sum >/dev/null 2>&1; then sha1sum "$2" | cut -d' ' -f1
        else shasum -a 1 "$2" | cut -d' ' -f1; fi
    fi
}
fail=0
while IFS=$'\t' read -r rel url algo hex; do
    [ -z "$rel" ] && continue
    dest="$OUT/$rel"
    mkdir -p "$(dirname "$dest")"
    if ! curl -fSL --retry 3 --retry-delay 2 -o "$dest" "$url"; then echo "FAIL (download): $rel"; fail=1; continue; fi
    actual=$(digest "$algo" "$dest")
    if [ "$actual" != "$hex" ]; then echo "FAIL (digest $algo): $rel"; rm -f "$dest"; fail=1; continue; fi
    echo "OK: $rel"
done <<'EOF'

EOF
if [ "$fail" != "0" ]; then
    echo
    echo 'Есть ошибки — список выше. Повторите запуск: уже скачанные и проверенные файлы перескачиваются.'
    exit 1
fi
echo
echo "Все 0 тарболов скачаны и проверены: $OUT/"
echo 'Далее в checkout проекта: node scripts/supply/vendor.mjs --add out'
