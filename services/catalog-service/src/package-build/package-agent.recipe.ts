import { cleanBuildReason, parseBuildDiagnostic } from '../../../shared/package-build-diagnostics.cjs';
import { validateBuildPlan } from '../../../shared/package-build-plan.cjs';
import { ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { portablePath, TARGETS } from '../../../shared/runtime-artifacts.cjs';
import { isSourceEntrypoint } from '../../../shared/source-entrypoint.cjs';
import type { BuildConfiguration } from './package-build.model';
import type { PackageAgentContext, PackageAgentRecipe, PackageAgentRuntimeReport } from './package-agent.model';

export const agentObject = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
const canonical = (value: unknown): unknown =>
    Array.isArray(value)
        ? value.map(canonical)
        : agentObject(value)
          ? Object.fromEntries(
                Object.keys(value)
                    .sort()
                    .map((key) => [key, canonical(value[key])]),
            )
          : value;
export const agentHash = (value: unknown): string =>
    createHash('sha256')
        .update(JSON.stringify(canonical(value)))
        .digest('hex');

/** Recipe choices may vary; source, inventory, model and publication pins remain immutable. */
export function packageAgentSourceHash(config: BuildConfiguration): string {
    const {
        entrypoint: _entrypoint,
        args: _args,
        ...source
    } = config.source as BuildConfiguration['source'] & { args?: string[]; entrypoint?: string };
    const { buildDiagnostics: _diagnostics, buildPlan: _plan, ...identity } = config;
    return agentHash({ ...identity, source });
}
const argsOf = (config: BuildConfiguration): string[] =>
    config.source.type === 'files' ? [...(config.source.args ?? [])] : [];
export function packageAgentRecipe(config: BuildConfiguration): PackageAgentRecipe {
    if (config.source.type === 'bundled')
        throw new ConflictException('Закреплённый рецепт каталога не меняется агентом.');
    if (config.recipeVersion === 2 && config.recipeInventory) return config.buildPlan ?? { schemaVersion: 2 };
    return {
        entrypoint: config.source.entrypoint,
        ...(config.source.type === 'files' ? { args: argsOf(config) } : {}),
    };
}
interface RecipeChoices {
    entrypoints: string[];
    arguments: string[][];
}
export function packageAgentChoices(original: BuildConfiguration, context: PackageAgentContext): RecipeChoices {
    if (original.source.type === 'bundled')
        throw new ConflictException('Закреплённый рецепт каталога не меняется агентом.');
    if (original.kind === 'skill') throw new ConflictException('Агент «Упаковщик» пока работает с MCP и плагинами.');
    const source = original.source,
        fixed =
            source.type === 'upload' || (source.type === 'repository' && !!(source.runtimeSource || source.release));
    const entrypoints = [...new Set([source.entrypoint, ...context.candidates])];
    if (
        entrypoints.length > 32 ||
        entrypoints.some(
            (value) =>
                typeof value !== 'string' ||
                value.length > 256 ||
                !portablePath(value) ||
                (!fixed && !isSourceEntrypoint(value)),
        )
    )
        throw new ConflictException('Агенту нужны до 32 проверенных файлов запуска закреплённого исходника.');
    const verified =
        source.type === 'files'
            ? entrypoints.filter((value) => source.files.some((file) => file.path === value && file.content.trim()))
            : entrypoints;
    if (verified.length !== entrypoints.length)
        throw new ConflictException('Файл запуска агента отсутствует в исходниках.');
    const argumentsList =
        source.type === 'files'
            ? [argsOf(original), [], ...(context.argumentCandidates ?? []).map((args) => [...args])]
            : [[]];
    if (
        argumentsList.length > 10 ||
        argumentsList.some(
            (args) =>
                !Array.isArray(args) ||
                args.length > 16 ||
                args.some((arg) => typeof arg !== 'string' || arg.length > 256 || /[\x00-\x1f\x7f]/.test(arg)),
        )
    )
        throw new ConflictException('Аргументы агента должны быть заранее проверены и ограничены.');
    if (
        argumentsList.some((args) =>
            args.some((arg) => /(?:password|secret|token|authorization|credential|api[-_]?key)/i.test(arg)),
        )
    )
        throw new ConflictException(
            'Аргументы с учётными данными нельзя передавать агенту. Настройте секреты после установки.',
        );
    const choices = {
        entrypoints: fixed ? [source.entrypoint] : verified,
        arguments: [...new Map(argumentsList.map((args) => [JSON.stringify(args), args])).values()],
    };
    if (Buffer.byteLength(JSON.stringify(choices)) > 12000)
        throw new ConflictException('Слишком много вариантов рецепта. Сократите список файлов запуска и аргументов.');
    return choices;
}

/** Model text is data: exact JSON keys and trusted choices replace executable tools. */
export function parsePackageAgentRecipe(
    value: unknown,
    current: BuildConfiguration,
    original: BuildConfiguration,
    context: PackageAgentContext,
): BuildConfiguration {
    if (current.source.type === 'bundled' || original.source.type === 'bundled')
        throw new ConflictException('Закреплённый рецепт каталога не меняется агентом.');
    if (original.recipeVersion === 2 && original.recipeInventory) {
        if (packageAgentSourceHash(current) !== packageAgentSourceHash(original))
            throw new ConflictException('Закреплённый исходник рецепта изменился.');
        const buildPlan = validateBuildPlan(value, original.recipeInventory);
        return { ...current, buildPlan, source: { ...current.source, entrypoint: buildPlan.entrypoint } };
    }
    if (
        !agentObject(value) ||
        Object.keys(value).some((key) => !['entrypoint', 'args'].includes(key)) ||
        typeof value.entrypoint !== 'string'
    )
        throw new ConflictException('Агент вернул некорректный рецепт. Нужен JSON с entrypoint и args.');
    const choices = packageAgentChoices(original, context),
        args = value.args === undefined ? [] : value.args;
    if (
        !choices.entrypoints.includes(value.entrypoint) ||
        !Array.isArray(args) ||
        !choices.arguments.some((candidate) => JSON.stringify(candidate) === JSON.stringify(args))
    )
        throw new ConflictException('Агент предложил файл или аргументы вне проверенного закреплённого исходника.');
    if (current.source.type !== 'files' && value.args !== undefined)
        throw new ConflictException('Этот источник не поддерживает изменение аргументов.');
    if (packageAgentSourceHash(current) !== packageAgentSourceHash(original))
        throw new ConflictException('Агент не может менять исходник, платформы или цель публикации.');
    return {
        ...current,
        source: {
            ...current.source,
            entrypoint: value.entrypoint,
            ...(current.source.type === 'files' ? { args: [...(args as string[])] } : {}),
        },
    } as BuildConfiguration;
}

/** Runtime diagnostics are bounded and redacted before being sent back to a model. */
export function packageAgentReport(report: PackageAgentRuntimeReport): PackageAgentRuntimeReport {
    if (
        typeof report.passed !== 'boolean' ||
        (report.diagnostics !== undefined &&
            (!Array.isArray(report.diagnostics) || report.diagnostics.some((value) => typeof value !== 'string'))) ||
        (report.summary !== undefined && typeof report.summary !== 'string')
    )
        throw new ConflictException('Нужен результат реальной проверки runtime.');
    const build = report.build === undefined ? undefined : parseBuildDiagnostic(report.build, TARGETS);
    if (report.build !== undefined && !build) throw new ConflictException('Некорректная диагностика сборки.');
    return {
        passed: report.passed,
        ...(build ? { build } : {}),
        ...(report.summary ? { summary: cleanBuildReason(report.summary) } : {}),
        ...(report.diagnostics ? { diagnostics: report.diagnostics.slice(0, 6).map(cleanBuildReason) } : {}),
    };
}
export function packageAgentRecipeAudit(config: BuildConfiguration): Record<string, unknown> {
    if (config.source.type === 'bundled') return { sourceRevision: config.source.revision };
    const recipe = { entrypoint: config.source.entrypoint, args: argsOf(config) };
    if (config.recipeVersion === 2)
        return {
            schemaVersion: 2,
            ...(config.buildPlan
                ? {
                      entrypoint: config.buildPlan.entrypoint,
                      plan: config.buildPlan,
                      planSha256: agentHash(config.buildPlan),
                  }
                : {}),
        };
    return {
        entrypoint: recipe.entrypoint,
        argumentCount: recipe.args?.length ?? 0,
        argsSha256: agentHash(recipe.args ?? []),
    };
}
export function packageAgentReportAudit(report?: PackageAgentRuntimeReport): Record<string, unknown> {
    return report
        ? {
              passed: report.passed,
              ...(report.build ? { buildStage: report.build.stage, buildCode: report.build.code } : {}),
              diagnosticCount: report.diagnostics?.length ?? 0,
              diagnosticsSha256: agentHash(report),
          }
        : {};
}
