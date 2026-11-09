'use strict';
/**
 * AD-13: negotiation-identity of the asset contract.
 * `CONTRACT_VERSION` is re-exported from the pinned asset contract (single source, like AD-12 ceilings);
 * the strict-semver helpers are shared by catalog, gateway and bridge without a new dependency.
 */
const { CONTRACT_VERSION } = require('@neurocenter/asset-contract');
/**
 * OQ3: contract versions are stable releases — exactly `MAJOR.MINOR.PATCH`,
 * no pre-release/build metadata, no leading zeros, components up to 9999.
 */
const CONTRACT_VERSION_PATTERN = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/;
function isContractVersion(value) {
    return typeof value === 'string' && CONTRACT_VERSION_PATTERN.test(value);
}
/** Численное сравнение двух проверенных версий: отрицательное — ниже, ноль — равны, положительное — выше. */
function compareContractVersions(left, right) {
    const [aMajor, aMinor, aPatch] = left.split('.').map((part) => Number(part)),
        [bMajor, bMinor, bPatch] = right.split('.').map((part) => Number(part));
    if (aMajor !== bMajor) return aMajor < bMajor ? -1 : 1;
    if (aMinor !== bMinor) return aMinor < bMinor ? -1 : 1;
    if (aPatch !== bPatch) return aPatch < bPatch ? -1 : 1;
    return 0;
}
module.exports = { CONTRACT_VERSION, isContractVersion, compareContractVersions };
