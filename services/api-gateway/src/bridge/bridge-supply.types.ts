export interface IBridgeArtifact {
    file: string; target: string; sha256: string; bytes: number;
    metadata: { version: string; buildId: string; target: string; sha256: string; bytes: number; [key: string]: unknown };
}

export interface IBridgeSupply {
    assetId: string; version: string; buildId: string; sourceCommit: string; artifacts: IBridgeArtifact[];
}
