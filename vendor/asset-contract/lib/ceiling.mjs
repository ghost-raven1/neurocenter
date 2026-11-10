/**
 * Contract constants (AD-12): single source of artifact-section ceilings and contract identity.
 * The vendor contract never reads limits from the environment (AD-2/AD-12); values here are
 * compile-time constants. Any ceiling change is a new contract release plus re-pin plus bump test.
 */
/** AD-1 interim artifact-section ceiling (the only set until finalization). */
export const ARTIFACT_CEILING=Object.freeze({compressedBytes:1024**3,unpackedBytes:4*1024**3,filesCount:100000,cacheBytes:8*1024**3});
/** Semver of this contract build; new publications must carry exactly this version (AD-13). */
export const CONTRACT_VERSION='1.3.0';
/** AD-13 capability families: floor-only checks (===5/===2) widened to [min,max] ranges. */
export const PACKAGE_FORMAT_RANGE=Object.freeze({min:5,max:5});
export const BRIDGE_PROTOCOL_RANGE=Object.freeze({min:2,max:2});
