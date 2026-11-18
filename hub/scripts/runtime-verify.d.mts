export declare function sha256(bytes: string | Uint8Array): string;

export interface RuntimeProvenance {
  configSha256: string;
  files: Record<string, string>;
  [key: string]: unknown;
}

export declare function checkRuntime(plugin: string, input: {
  provenance: string | Uint8Array;
  config: string | Uint8Array;
  names: string[];
  read(name: string): string | Uint8Array;
}): RuntimeProvenance;

export declare function verifyRuntimeDir(runtimesDir: string, plugin: string): RuntimeProvenance;
