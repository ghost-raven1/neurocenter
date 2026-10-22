export interface IBridgeArtifact {
    file: string; target: string; sha256: string; bytes: number;
    metadata: { version: string; buildId: string; target: string; sha256: string; bytes: number; [key: string]: unknown };
}

export interface IBridgeSupply {
    assetId: string; version: string; buildId: string; sourceCommit: string; artifacts: IBridgeArtifact[];
}

/** Публичная настройка установщика не раскрывает локальные пути или внутренние описи архивов. */
export interface IBridgeConfiguration {
    origin: string;
    devSupply?: { version: string; buildId: string; targets: string[] };
}
