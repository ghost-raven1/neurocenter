# Dependency audit: lockfile vs локальные registry (2026-11-05)

Registry chain: artifactory `ppod-npm-trusted` → `ppod-npm-virtual` → nexus `ppod-npm-virtual` (взят первый, где пакет найден). Версии — точные из всех 13 package-lock.json.

- unique packages: **987**
- полностью доступны: **694**
- версия не совпадает: **249**
- НЕ найдены нигде: **44**

## Не найдены в локальных registry (кандидаты на удаление/вендор)

| package | версии в lockfile |
|---|---|
| ../../vendor/asset-contract | 1.2.1 |
| @ai-sdk/gateway | 3.0.220 |
| @ai-sdk/provider-utils | 4.0.62 |
| @asamuzakjp/generational-cache | 1.0.1 |
| @chainsafe/is-ip | 2.1.0 |
| @lancedb/lancedb | 0.29.0 |
| @lancedb/lancedb-darwin-arm64 | 0.29.0 |
| @lancedb/lancedb-linux-arm64-gnu | 0.29.0 |
| @lancedb/lancedb-linux-arm64-musl | 0.29.0 |
| @lancedb/lancedb-linux-x64-gnu | 0.29.0 |
| @lancedb/lancedb-linux-x64-musl | 0.29.0 |
| @lancedb/lancedb-win32-arm64-msvc | 0.29.0 |
| @lancedb/lancedb-win32-x64-msvc | 0.29.0 |
| @lukeed/csprng | 1.1.0 |
| @msgpackr-extract/msgpackr-extract-darwin-arm64 | 3.0.4 |
| @msgpackr-extract/msgpackr-extract-darwin-x64 | 3.0.4 |
| @msgpackr-extract/msgpackr-extract-linux-arm | 3.0.4 |
| @msgpackr-extract/msgpackr-extract-linux-arm64 | 3.0.4 |
| @msgpackr-extract/msgpackr-extract-linux-x64 | 3.0.4 |
| @msgpackr-extract/msgpackr-extract-win32-x64 | 3.0.4 |
| @nestjs/swagger | 11.4.7 |
| @neurocenter/ollama-runtime | 1.0.0 |
| @nodable/entities | 3.1.0 |
| @renovatebot/pep440 | 5.0.1 |
| @rolldown/binding-android-arm-eabi | 1.2.14, 1.2.15 |
| @types/mozilla__readability | 0.4.2 |
| @types/turndown | 5.0.6 |
| @vercel/oidc | 3.2.0 |
| ai | 6.0.314 |
| anynum | 1.0.1 |
| browser-or-node | 2.1.1 |
| fast-xml-builder | 1.3.1 |
| is-unsafe | 2.0.2 |
| load-esm | 1.0.3 |
| micromark-util-edit-map | 1.0.0 |
| msgpackr-extract | 3.0.4 |
| node-gyp-build-optional-packages | 5.2.2 |
| ollama-ai-provider-v2 | 3.5.1 |
| path-expression-matcher | 1.6.2 |
| private-ip | 3.0.2 |
| stream-chain | 2.2.5 |
| stream-json | 1.9.1 |
| vendor/asset-contract | 1.2.1 |
| xml-naming | 0.3.0 |

## Версии не совпадают (нужен align до локальной)

| package | в lockfile | найдено в | ближайшее локальное |
|---|---|---|---|
| @acemir/cssom | 0.9.32 | artifactory-trusted | 0.9.32≈0.9.31 |
| @ai-sdk/provider | 3.0.19 | artifactory-trusted | 3.0.19≈3.0.8 |
| @angular-devkit/core | 19.2.27, 19.2.24 | artifactory-trusted | 19.2.27≈17.3.11, 19.2.24≈17.3.11 |
| @angular-devkit/schematics | 19.2.27, 19.2.24 | artifactory-trusted | 19.2.27≈17.3.11, 19.2.24≈17.3.11 |
| @angular-devkit/schematics-cli | 19.2.27 | artifactory-trusted | 19.2.27≈16.0.1 |
| @asamuzakjp/css-color | 5.1.11 | artifactory-trusted | 5.1.11≈4.1.2 |
| @bramus/specificity | 2.4.3 | artifactory-trusted | 2.4.3≈2.4.2 |
| @cacheable/memory | 2.2.0 | artifactory-trusted | 2.2.0≈2.0.7 |
| @cacheable/utils | 2.5.0 | artifactory-trusted | 2.5.0≈2.4.1 |
| @csstools/color-helpers | 6.1.2 | artifactory-trusted | 6.1.2≈6.0.1 |
| @csstools/css-calc | 3.4.3 | artifactory-trusted | 3.4.3≈3.1.1 |
| @csstools/css-color-parser | 4.2.6 | artifactory-trusted | 4.2.6≈4.0.1 |
| @csstools/css-parser-algorithms | 4.0.2 | artifactory-trusted | 4.0.2≈4.0.0 |
| @csstools/css-syntax-patches-for-csstree | 1.1.15 | artifactory-trusted | 1.1.15≈1.0.27 |
| @csstools/css-tokenizer | 4.0.2 | artifactory-trusted | 4.0.2≈4.0.0 |
| @esbuild/aix-ppc64 | 0.28.2 | artifactory-trusted | 0.28.2≈0.28.1 |
| @esbuild/android-arm | 0.28.2 | artifactory-trusted | 0.28.2≈0.28.1 |
| @esbuild/android-arm64 | 0.28.2 | artifactory-trusted | 0.28.2≈0.28.1 |
| @esbuild/android-x64 | 0.28.2 | artifactory-trusted | 0.28.2≈0.28.1 |
| @esbuild/darwin-arm64 | 0.28.2 | artifactory-trusted | 0.28.2≈0.28.1 |
| @esbuild/darwin-x64 | 0.28.2 | artifactory-trusted | 0.28.2≈0.28.1 |
| @esbuild/freebsd-arm64 | 0.28.2 | artifactory-trusted | 0.28.2≈0.28.1 |
| @esbuild/freebsd-x64 | 0.28.2 | artifactory-trusted | 0.28.2≈0.28.1 |
| @esbuild/linux-arm | 0.28.2 | artifactory-trusted | 0.28.2≈0.28.1 |
| @esbuild/linux-arm64 | 0.28.2 | artifactory-trusted | 0.28.2≈0.28.1 |
| @esbuild/linux-ia32 | 0.28.2 | artifactory-trusted | 0.28.2≈0.28.1 |
| @esbuild/linux-loong64 | 0.28.2 | artifactory-trusted | 0.28.2≈0.28.1 |
| @esbuild/linux-mips64el | 0.28.2 | artifactory-trusted | 0.28.2≈0.28.1 |
| @esbuild/linux-ppc64 | 0.28.2 | artifactory-trusted | 0.28.2≈0.28.1 |
| @esbuild/linux-riscv64 | 0.28.2 | artifactory-trusted | 0.28.2≈0.28.1 |
| @esbuild/linux-s390x | 0.28.2 | artifactory-trusted | 0.28.2≈0.28.1 |
| @esbuild/linux-x64 | 0.28.2 | artifactory-trusted | 0.28.2≈0.28.1 |
| @esbuild/netbsd-arm64 | 0.28.2 | artifactory-trusted | 0.28.2≈0.28.1 |
| @esbuild/netbsd-x64 | 0.28.2 | artifactory-trusted | 0.28.2≈0.28.1 |
| @esbuild/openbsd-arm64 | 0.28.2 | artifactory-trusted | 0.28.2≈0.28.1 |
| @esbuild/openbsd-x64 | 0.28.2 | artifactory-trusted | 0.28.2≈0.28.1 |
| @esbuild/openharmony-arm64 | 0.28.2 | artifactory-trusted | 0.28.2≈0.28.1 |
| @esbuild/sunos-x64 | 0.28.2 | artifactory-trusted | 0.28.2≈0.28.1 |
| @esbuild/win32-arm64 | 0.28.2 | artifactory-trusted | 0.28.2≈0.28.1 |
| @esbuild/win32-ia32 | 0.28.2 | artifactory-trusted | 0.28.2≈0.28.1 |
| @esbuild/win32-x64 | 0.28.2 | artifactory-trusted | 0.28.2≈0.28.1 |
| @eslint/config-helpers | 0.7.0 | artifactory-trusted | 0.7.0≈0.6.0 |
| @eslint/plugin-kit | 0.7.3 | artifactory-trusted | 0.7.3≈0.7.2 |
| @exodus/bytes | 1.16.0 | artifactory-trusted | 1.16.0≈1.14.1 |
| @hono/node-server | 2.1.5, 2.1.4 | artifactory-trusted | 2.1.5≈1.19.9, 2.1.4≈1.19.9 |
| @inquirer/prompts | 7.3.2 | artifactory-trusted | 7.3.2≈7.10.1 |
| @microsoft/tsdoc | 0.16.0 | artifactory-trusted | 0.16.0≈0.14.2 |
| @modelcontextprotocol/sdk | 1.32.2 | artifactory-trusted | 1.32.2≈1.32.1 |
| @napi-rs/canvas | 1.0.13 | artifactory-trusted | 1.0.13≈0.1.78 |
| @napi-rs/canvas-android-arm64 | 1.0.13 | artifactory-trusted | 1.0.13≈0.1.78 |
| @napi-rs/canvas-darwin-arm64 | 1.0.13 | artifactory-trusted | 1.0.13≈0.1.78 |
| @napi-rs/canvas-darwin-x64 | 1.0.13 | artifactory-trusted | 1.0.13≈0.1.78 |
| @napi-rs/canvas-linux-arm-gnueabihf | 1.0.13 | artifactory-trusted | 1.0.13≈0.1.78 |
| @napi-rs/canvas-linux-arm64-gnu | 1.0.13 | artifactory-trusted | 1.0.13≈0.1.78 |
| @napi-rs/canvas-linux-arm64-musl | 1.0.13 | artifactory-trusted | 1.0.13≈0.1.78 |
| @napi-rs/canvas-linux-riscv64-gnu | 1.0.13 | artifactory-trusted | 1.0.13≈0.1.78 |
| @napi-rs/canvas-linux-x64-gnu | 1.0.13 | artifactory-trusted | 1.0.13≈0.1.78 |
| @napi-rs/canvas-linux-x64-musl | 1.0.13 | artifactory-trusted | 1.0.13≈0.1.78 |
| @napi-rs/canvas-win32-arm64-msvc | 1.0.13 | artifactory-trusted | 1.0.13≈0.1.89 |
| @napi-rs/canvas-win32-x64-msvc | 1.0.13 | artifactory-trusted | 1.0.13≈0.1.78 |
| @nestjs/cli | 11.0.24 | artifactory-trusted | 11.0.24≈9.5.0 |
| @nestjs/common | 11.2.7 | artifactory-trusted | 11.2.7≈8.0.5 |
| @nestjs/config | 4.0.4 | artifactory-trusted | 4.0.4≈1.0.1 |
| @nestjs/core | 11.2.7 | artifactory-trusted | 11.2.7≈8.0.5 |
| @nestjs/mapped-types | 2.1.1 | artifactory-trusted | 2.1.1≈1.0.0 |
| @nestjs/platform-express | 11.2.7 | artifactory-trusted | 11.2.7≈8.0.5 |
| @nestjs/schematics | 11.1.0 | artifactory-trusted | 11.1.0≈9.2.0 |
| @opencode-ai/plugin | 1.14.48 | artifactory-trusted | 1.14.48≈1.18.10 |
| @opencode-ai/sdk | 1.14.48 | artifactory-trusted | 1.14.48≈1.18.10 |
| @oxc-project/types | 0.154.0, 0.155.0 | artifactory-trusted | 0.154.0≈0.142.0, 0.155.0≈0.142.0 |
| @rolldown/binding-android-arm64 | 1.2.14, 1.2.15 | artifactory-trusted | 1.2.14≈1.1.5, 1.2.15≈1.1.5 |
| @rolldown/binding-darwin-arm64 | 1.2.14, 1.2.15 | artifactory-trusted | 1.2.14≈1.1.5, 1.2.15≈1.1.5 |
| @rolldown/binding-darwin-x64 | 1.2.14, 1.2.15 | artifactory-trusted | 1.2.14≈1.1.5, 1.2.15≈1.1.5 |
| @rolldown/binding-freebsd-x64 | 1.2.14, 1.2.15 | artifactory-trusted | 1.2.14≈1.1.5, 1.2.15≈1.1.5 |
| @rolldown/binding-linux-arm-gnueabihf | 1.2.14, 1.2.15 | artifactory-trusted | 1.2.14≈1.1.5, 1.2.15≈1.1.5 |
| @rolldown/binding-linux-arm64-gnu | 1.2.14, 1.2.15 | artifactory-trusted | 1.2.14≈1.1.5, 1.2.15≈1.1.5 |
| @rolldown/binding-linux-arm64-musl | 1.2.14, 1.2.15 | artifactory-trusted | 1.2.14≈1.1.5, 1.2.15≈1.1.5 |
| @rolldown/binding-linux-ppc64-gnu | 1.2.14, 1.2.15 | artifactory-trusted | 1.2.14≈1.1.5, 1.2.15≈1.1.5 |
| @rolldown/binding-linux-s390x-gnu | 1.2.14, 1.2.15 | artifactory-trusted | 1.2.14≈1.1.5, 1.2.15≈1.1.5 |
| @rolldown/binding-linux-x64-gnu | 1.2.14, 1.2.15 | artifactory-trusted | 1.2.14≈1.2.2, 1.2.15≈1.2.2 |
| @rolldown/binding-linux-x64-musl | 1.2.14, 1.2.15 | artifactory-trusted | 1.2.14≈1.2.2, 1.2.15≈1.2.2 |
| @rolldown/binding-openharmony-arm64 | 1.2.14, 1.2.15 | artifactory-trusted | 1.2.14≈1.1.5, 1.2.15≈1.1.5 |
| @rolldown/binding-win32-arm64-msvc | 1.2.14, 1.2.15 | artifactory-trusted | 1.2.14≈1.1.5, 1.2.15≈1.1.5 |
| @rolldown/binding-win32-x64-msvc | 1.2.14, 1.2.15 | artifactory-trusted | 1.2.14≈1.1.5, 1.2.15≈1.1.5 |
| @rollup/rollup-android-arm-eabi | 4.64.7 | artifactory-trusted | 4.64.7≈4.62.5 |
| @rollup/rollup-android-arm64 | 4.64.7 | artifactory-trusted | 4.64.7≈4.62.5 |
| @rollup/rollup-darwin-arm64 | 4.64.7 | artifactory-trusted | 4.64.7≈4.62.5 |
| @rollup/rollup-darwin-x64 | 4.64.7 | artifactory-trusted | 4.64.7≈4.62.5 |
| @rollup/rollup-freebsd-arm64 | 4.64.7 | artifactory-trusted | 4.64.7≈4.62.5 |
| @rollup/rollup-freebsd-x64 | 4.64.7 | artifactory-trusted | 4.64.7≈4.62.5 |
| @rollup/rollup-linux-arm-gnueabihf | 4.64.7 | artifactory-trusted | 4.64.7≈4.62.5 |
| @rollup/rollup-linux-arm-musleabihf | 4.64.7 | artifactory-trusted | 4.64.7≈4.62.5 |
| @rollup/rollup-linux-arm64-gnu | 4.64.7 | artifactory-trusted | 4.64.7≈4.62.5 |
| @rollup/rollup-linux-arm64-musl | 4.64.7 | artifactory-trusted | 4.64.7≈4.62.5 |
| @rollup/rollup-linux-loong64-gnu | 4.64.7 | artifactory-trusted | 4.64.7≈4.62.5 |
| @rollup/rollup-linux-loong64-musl | 4.64.7 | artifactory-trusted | 4.64.7≈4.62.5 |
| @rollup/rollup-linux-ppc64-gnu | 4.64.7 | artifactory-trusted | 4.64.7≈4.62.5 |
| @rollup/rollup-linux-ppc64-musl | 4.64.7 | artifactory-trusted | 4.64.7≈4.62.5 |
| @rollup/rollup-linux-riscv64-gnu | 4.64.7 | artifactory-trusted | 4.64.7≈4.62.5 |
| @rollup/rollup-linux-riscv64-musl | 4.64.7 | artifactory-trusted | 4.64.7≈4.62.5 |
| @rollup/rollup-linux-s390x-gnu | 4.64.7 | artifactory-trusted | 4.64.7≈4.62.5 |
| @rollup/rollup-linux-x64-gnu | 4.64.7 | artifactory-trusted | 4.64.7≈4.62.5 |
| @rollup/rollup-linux-x64-musl | 4.64.7 | artifactory-trusted | 4.64.7≈4.62.5 |
| @rollup/rollup-openbsd-x64 | 4.64.7 | artifactory-trusted | 4.64.7≈4.62.5 |
| @rollup/rollup-openharmony-arm64 | 4.64.7 | artifactory-trusted | 4.64.7≈4.62.5 |
| @rollup/rollup-win32-arm64-msvc | 4.64.7 | artifactory-trusted | 4.64.7≈4.62.5 |
| @rollup/rollup-win32-ia32-msvc | 4.64.7 | artifactory-trusted | 4.64.7≈4.62.5 |
| @rollup/rollup-win32-x64-gnu | 4.64.7 | artifactory-trusted | 4.64.7≈4.62.5 |
| @rollup/rollup-win32-x64-msvc | 4.64.7 | artifactory-trusted | 4.64.7≈4.62.5 |
| @tokenizer/inflate | 0.4.1 | artifactory-trusted | 0.4.1≈0.2.7 |
| @tsconfig/node10 | 1.0.13 | artifactory-trusted | 1.0.13≈1.0.12 |
| @types/bun | 1.4.4 | artifactory-trusted | 1.4.4≈1.3.14 |
| @types/command-line-args | 5.2.3 | artifactory-trusted | 5.2.3≈5.2.0 |
| @types/command-line-usage | 5.0.4 | artifactory-trusted | 5.0.4≈5.0.2 |
| @types/estree | 1.0.10 | artifactory-trusted | 1.0.10≈1.0.9 |
| @types/hast | 3.0.5 | artifactory-trusted | 3.0.5≈3.0.4 |
| @types/jsdom | 28.0.3 | artifactory-trusted | 28.0.3≈21.1.7 |
| @types/node | 22.20.5, 20.19.43, 26.6.6 | artifactory-trusted | 22.20.5≈22.15.2, 20.19.43≈20.19.37, 26.6.6≈26.6.5 |
| @types/pg | 8.23.1 | artifactory-trusted | 8.23.1≈8.15.1 |
| @typescript-eslint/eslint-plugin | 8.72.0 | artifactory-trusted | 8.72.0≈8.67.0 |
| @typescript-eslint/parser | 8.72.0 | artifactory-trusted | 8.72.0≈8.67.0 |
| @typescript-eslint/project-service | 8.72.0 | artifactory-trusted | 8.72.0≈8.67.0 |
| @typescript-eslint/scope-manager | 8.72.0 | artifactory-trusted | 8.72.0≈8.67.0 |
| @typescript-eslint/tsconfig-utils | 8.72.0 | artifactory-trusted | 8.72.0≈8.67.0 |
| @typescript-eslint/type-utils | 8.72.0 | artifactory-trusted | 8.72.0≈8.67.0 |
| @typescript-eslint/types | 8.72.0 | artifactory-trusted | 8.72.0≈8.67.0 |
| @typescript-eslint/typescript-estree | 8.72.0 | artifactory-trusted | 8.72.0≈8.67.0 |
| @typescript-eslint/utils | 8.72.0 | artifactory-trusted | 8.72.0≈8.67.0 |
| @typescript-eslint/visitor-keys | 8.72.0 | artifactory-trusted | 8.72.0≈8.67.0 |
| @vitest/coverage-v8 | 4.1.12 | artifactory-trusted | 4.1.12≈4.1.10 |
| @vitest/expect | 4.1.12 | artifactory-trusted | 4.1.12≈4.1.10 |
| @vitest/mocker | 4.1.12 | artifactory-trusted | 4.1.12≈4.1.10 |
| @vitest/pretty-format | 4.1.12 | artifactory-trusted | 4.1.12≈4.1.10 |
| @vitest/runner | 4.1.12 | artifactory-trusted | 4.1.12≈4.1.10 |
| @vitest/snapshot | 4.1.12 | artifactory-trusted | 4.1.12≈4.1.10 |
| @vitest/spy | 4.1.12 | artifactory-trusted | 4.1.12≈4.1.10 |
| @vitest/utils | 4.1.12 | artifactory-trusted | 4.1.12≈4.1.10 |
| @xmldom/xmldom | 0.8.15 | artifactory-trusted | 0.8.15≈0.8.13 |
| ansis | 4.2.0 | artifactory-trusted | 4.2.0≈1.3.4 |
| apache-arrow | 18.1.0 | artifactory-trusted | 18.1.0≈14.0.2 |
| argparse | 3.0.3 | artifactory-trusted | 3.0.3≈2.0.1 |
| array-back | 6.2.3 | artifactory-trusted | 6.2.3≈6.2.2 |
| ast-v8-to-istanbul | 1.0.7 | artifactory-trusted | 1.0.7≈1.0.5 |
| baseline-browser-mapping | 2.11.29 | artifactory-trusted | 2.11.29≈2.11.28 |
| bidi-js | 1.1.0 | artifactory-trusted | 1.1.0≈1.0.3 |
| block-stream2 | 2.1.0 | artifactory-trusted | 2.1.0≈1.1.0 |
| body-parser | 2.4.0 | artifactory-trusted | 2.4.0≈2.3.0 |
| bun-types | 1.4.4 | artifactory-trusted | 1.4.4≈1.3.14 |
| cacheable | 2.5.0 | artifactory-trusted | 2.5.0≈2.3.2 |
| caniuse-lite | 1.0.30001816 | artifactory-trusted | 1.0.30001816≈1.0.30001815 |
| chai | 6.3.0 | artifactory-trusted | 6.3.0≈6.2.2 |
| command-line-usage | 7.0.4 | artifactory-trusted | 7.0.4≈7.0.3 |
| comment-json | 5.0.0 | artifactory-trusted | 5.0.0≈4.2.5 |
| cookie-parser | 1.4.7 | artifactory-trusted | 1.4.7≈1.4.6 |
| cssstyle | 6.2.0 | artifactory-trusted | 6.2.0≈6.0.1 |
| dingbat-to-unicode | 1.0.2 | artifactory-trusted | 1.0.2≈1.0.1 |
| dotenv | 17.4.1 | artifactory-trusted | 17.4.1≈17.3.1 |
| dotenv-expand | 12.0.3 | artifactory-trusted | 12.0.3≈10.0.0 |
| effect | 4.0.0-beta.59 | artifactory-trusted | 4.0.0-beta.59≈4.0.0-beta.83 |
| electron-to-chromium | 1.5.459 | artifactory-trusted | 1.5.459≈1.5.452 |
| encodeurl | 2.0.1 | artifactory-trusted | 2.0.1≈2.0.0 |
| engine.io | 6.6.11 | artifactory-trusted | 6.6.11≈6.6.9 |
| engine.io-client | 6.6.7 | artifactory-trusted | 6.6.7≈6.6.6 |
| entities | 8.1.0 | artifactory-trusted | 8.1.0≈7.0.1 |
| esbuild | 0.28.2 | artifactory-trusted | 0.28.2≈0.27.2 |
| eslint | 10.13.0 | artifactory-trusted | 10.13.0≈10.7.0 |
| eventsource-parser | 3.1.1 | artifactory-trusted | 3.1.1≈3.1.0 |
| express-rate-limit | 8.7.1 | artifactory-trusted | 8.7.1≈8.5.2 |
| fake-indexeddb | 6.2.6 | artifactory-trusted | 6.2.6≈4.0.1 |
| fast-check | 4.10.2 | artifactory-trusted | 4.10.2≈4.9.0 |
| fast-uri | 3.1.9 | artifactory-trusted | 3.1.9≈3.1.8 |
| fast-xml-parser | 5.11.2 | artifactory-trusted | 5.11.2≈5.3.6 |
| file-entry-cache | 11.1.5 | artifactory-trusted | 11.1.5≈11.1.2 |
| file-type | 21.3.4 | artifactory-trusted | 21.3.4≈17.1.6 |
| flat-cache | 6.1.23 | artifactory-trusted | 6.1.23≈6.1.22 |
| flatbuffers | 24.12.23 | artifactory-trusted | 24.12.23≈25.9.23 |
| globals | 17.13.0 | artifactory-trusted | 17.13.0≈17.7.0 |
| hono | 4.13.13, 4.13.14 | artifactory-trusted | 4.13.13≈4.12.30, 4.13.14≈4.12.30 |
| ignore | 7.0.14, 7.0.13 | artifactory-trusted | 7.0.14≈7.0.6, 7.0.13≈7.0.6 |
| ini | 6.0.0 | artifactory-trusted | 6.0.0≈7.0.0 |
| ip-address | 10.7.5 | artifactory-trusted | 10.7.5≈10.7.4 |
| ip-regex | 5.0.0 | artifactory-trusted | 5.0.0≈4.3.0 |
| jose | 6.2.12, 6.2.13, 6.2.14 | artifactory-trusted | 6.2.12≈6.2.3, 6.2.13≈6.2.3, 6.2.14≈6.2.3 |
| js-yaml | 5.5.0, 5.3.0 | artifactory-trusted | 5.5.0≈5.4.3, 5.3.0≈5.2.2 |
| jszip | 3.10.2 | artifactory-trusted | 3.10.2≈3.10.1 |
| magicast | 0.5.5 | artifactory-trusted | 0.5.5≈0.5.3 |
| mdast-util-find-and-replace | 3.0.3 | artifactory-trusted | 3.0.3≈3.0.2 |
| mdast-util-from-markdown | 2.1.0 | artifactory-trusted | 2.1.0≈2.0.1 |
| mdast-util-gfm-strikethrough | 2.0.1 | artifactory-trusted | 2.0.1≈2.0.0 |
| mdast-util-to-markdown | 2.2.0 | artifactory-trusted | 2.2.0≈2.1.0 |
| micromark | 4.0.3 | artifactory-trusted | 4.0.3≈4.0.2 |
| micromark-core-commonmark | 2.0.4 | artifactory-trusted | 2.0.4≈2.0.3 |
| micromark-extension-gfm-table | 2.1.2 | artifactory-trusted | 2.1.2≈2.1.1 |
| micromark-factory-space | 2.1.0 | artifactory-trusted | 2.1.0≈2.0.0 |
| micromark-util-types | 2.0.3 | artifactory-trusted | 2.0.3≈2.0.2 |
| minimizer-webpack-plugin | 5.13.1 | artifactory-trusted | 5.13.1≈5.13.0 |
| minio | 8.0.7 | artifactory-trusted | 8.0.7≈6.0.0 |
| msgpackr | 1.12.1 | artifactory-trusted | 1.12.1≈2.0.5 |
| netmask | 2.1.1 | artifactory-trusted | 2.1.1≈2.0.2 |
| node-releases | 2.0.59 | artifactory-trusted | 2.0.59≈2.0.58 |
| obug | 2.2.1 | artifactory-trusted | 2.2.1≈2.1.1 |
| parse5 | 8.0.1 | artifactory-trusted | 8.0.1≈8.0.0 |
| pdfjs-dist | 6.3.289 | artifactory-trusted | 6.3.289≈5.4.296 |
| pg | 8.23.1 | artifactory-trusted | 8.23.1≈8.16.3 |
| pg-cloudflare | 1.4.1 | artifactory-trusted | 1.4.1≈1.2.7 |
| pg-connection-string | 2.14.1 | artifactory-trusted | 2.14.1≈2.9.1 |
| pg-pool | 3.14.0 | artifactory-trusted | 3.14.0≈3.10.1 |
| pg-protocol | 1.16.1 | artifactory-trusted | 1.16.1≈1.10.3 |
| postcss | 8.5.30, 8.5.31 | artifactory-trusted | 8.5.30≈8.5.29, 8.5.31≈8.5.29 |
| prettier | 3.9.10 | artifactory-trusted | 3.9.10≈3.9.6 |
| property-information | 7.2.0 | artifactory-trusted | 7.2.0≈7.1.0 |
| qs | 6.17.1 | artifactory-trusted | 6.17.1≈6.16.1 |
| query-string | 7.1.3 | artifactory-trusted | 7.1.3≈7.1.1 |
| rolldown | 1.2.14, 1.2.15 | artifactory-trusted | 1.2.14≈1.2.2, 1.2.15≈1.2.2 |
| rollup | 4.64.7 | artifactory-trusted | 4.64.7≈4.62.5 |
| schema-utils | 4.8.1 | artifactory-trusted | 4.8.1≈4.5.0 |
| smol-toml | 1.9.1 | artifactory-trusted | 1.9.1≈1.5.2 |
| socket.io-parser | 4.2.7 | artifactory-trusted | 4.2.7≈4.2.6 |
| std-env | 4.3.0 | artifactory-trusted | 4.3.0≈4.2.0 |
| string-width-cjs | 4.2.3 | artifactory-trusted | 4.2.3≈5.1.1 |
| strip-ansi-cjs | 6.0.1 | artifactory-trusted | 6.0.1≈8.0.0 |
| strnum | 2.5.1 | artifactory-trusted | 2.5.1≈2.1.2 |
| strtok3 | 10.6.2, 10.5.0 | artifactory-trusted | 10.6.2≈7.1.1, 10.5.0≈7.1.1 |
| tar | 7.5.22 | artifactory-trusted | 7.5.22≈7.5.19 |
| tinyexec | 1.3.1 | artifactory-trusted | 1.3.1≈1.2.4 |
| tinyrainbow | 3.2.0 | artifactory-trusted | 3.2.0≈3.1.0 |
| tldts | 7.4.19 | artifactory-trusted | 7.4.19≈7.0.23 |
| tldts-core | 7.4.20 | artifactory-trusted | 7.4.20≈7.0.23 |
| token-types | 6.1.2 | artifactory-trusted | 6.1.2≈5.0.1 |
| tough-cookie | 6.0.2 | artifactory-trusted | 6.0.2≈6.0.0 |
| ts-loader | 9.6.2 | artifactory-trusted | 9.6.2≈9.5.2 |
| tsx | 4.23.15 | artifactory-trusted | 4.23.15≈4.21.0 |
| turndown | 7.2.4 | artifactory-trusted | 7.2.4≈7.2.2 |
| typescript-eslint | 8.72.0 | artifactory-trusted | 8.72.0≈8.67.0 |
| typical | 7.3.0 | artifactory-trusted | 7.3.0≈7.2.0 |
| uid | 2.0.2 | artifactory-trusted | 2.0.2≈0.0.2 |
| uint8array-extras | 1.6.0 | artifactory-trusted | 1.6.0≈1.4.0 |
| undici | 6.29.1, 7.30.1 | artifactory-trusted | 6.29.1≈6.23.0, 7.30.1≈7.29.0 |
| undici-types | 7.30.1 | artifactory-trusted | 7.30.1≈7.19.2 |
| uuid | 13.0.2 | artifactory-trusted | 13.0.2≈14.0.1 |
| vite | 8.3.4, 7.3.7, 8.3.5 | artifactory-trusted | 8.3.4≈8.2.0, 7.3.7≈7.3.1, 8.3.5≈8.2.0 |
| vitest | 4.1.12 | artifactory-trusted | 4.1.12≈4.1.10 |
| watchpack | 2.6.3 | artifactory-trusted | 2.6.3≈2.5.2 |
| webpack | 5.106.2, 5.112.0 | artifactory-trusted | 5.106.2≈5.105.4, 5.112.0≈5.109.2 |
| wordwrapjs | 5.1.1 | artifactory-trusted | 5.1.1≈5.1.0 |
| wrap-ansi-cjs | 7.0.0 | artifactory-trusted | 7.0.0≈8.0.0 |
| xml2js | 0.6.2 | artifactory-trusted | 0.6.2≈0.5.0 |
| yauzl | 3.4.0 | artifactory-trusted | 3.4.0≈3.3.0 |
| zod | 4.6.7 | artifactory-trusted | 4.6.7≈4.6.5 |
