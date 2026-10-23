/** @file Generated from schemas/release.config.schema.json by npm run generate:types. */

/**
 * This interface was referenced by `ReleaseConfiguration`'s JSON-Schema
 * via the `definition` "component".
 */
export type TargetConfiguration = Component;

/**
 * Declarative application boundary. The package validator additionally checks component references, supported ordering and version lane consistency.
 */
export interface ReleaseConfiguration {
  schemaVersion: 1;
  repository: string;
  defaultBranch: string;
  defaultProfile?: string;
  packageDirectories?: string[];
  profiles?: {
    [k: string]: {
      easProfile?: string;
      channel?: string;
      environment?: string;
      distribution?: string;
      submit?: boolean;
      execution?: 'local' | 'hosted';
      environmentSource?: 'declared' | 'provider';
      publicEnvironment?: {
        [k: string]: string;
      };
      expo?: {
        serverUrl?: string;
        [k: string]: unknown;
      };
      [k: string]: unknown;
    };
  };
  /**
   * At most one server component is supported by the fixed deployment target; the runtime validator checks this constraint.
   *
   * @minItems 1
   */
  components: [TargetConfiguration, ...TargetConfiguration[]];
  /**
   * Project/owner/server values may use inert JSON file/pointer mappings; no executable configuration is loaded by privileged jobs.
   */
  expo?: {
    [k: string]: unknown;
  };
  hooks?: {
    inspect?: Hook;
    prepare?: Hook;
    validate?: Hook;
    build?: Hook;
    verify?: Hook;
  };
  versionGroups?: {
    id: string;
    /**
     * @minItems 1
     */
    targets: [string, ...string[]];
    version?: JsonMapping;
    codeAllocation?: 'global' | 'independent';
    bump?: 'patch' | 'requested';
    minimumCode?: number;
    reusePrepared?: boolean;
    lanes?: {
      [k: string]: {
        modulus: number;
        residue: number;
      };
    };
    minimumVersion?: string;
    minimumCodes?: {
      [k: string]: number;
    };
    [k: string]: unknown;
  }[];
  policy?: {
    [k: string]: unknown;
  };
  local?: {
    settingsDirectory?: string;
    settingsFile?: string;
    /**
     * Explicit local Android internal-track permission. Local evidence never becomes hosted provenance.
     */
    submissions?: {
      [k: string]: {
        track: string;
        [k: string]: unknown;
      };
    };
  };
  promotions?: {
    [k: string]: PromotionConfiguration;
  };
  github?: {
    requestWorkflow?: string;
    handlerWorkflow?: string;
    recoveryWorkflow?: string;
    [k: string]: unknown;
  };
  deployment?: {
    type: 'wireguard-webhook';
    [k: string]: unknown;
  };
  nativeGroups?: [string, string, ...string[]][];
  dependencies?: {
    component: string;
    requires: string[];
    when?: 'version-reservation';
    [k: string]: unknown;
  }[];
  inspection?: {
    environment?: {
      [k: string]: string;
    };
    [k: string]: unknown;
  };
  validation?: {
    environment?: {
      [k: string]: string;
    };
    [k: string]: unknown;
  };
  attestations?: {
    [k: string]: unknown;
  };
  metadataFiles?: string[];
  trust?: {
    [k: string]: unknown;
  };
}
export interface Component {
  id: string;
  kind: 'server' | 'native' | 'ota';
  platform?: 'android' | 'ios';
  builder?: 'command' | 'eas';
  /**
   * Explicit local-only override. EAS local builds support iOS on macOS; hosted builder policy is unchanged.
   */
  localBuilder?: 'command' | 'eas';
  appDirectory?: string;
  applicationId?: string;
  nativeTarget?: string;
  version?: JsonMapping;
  runtimePolicy?: 'appVersion' | 'fingerprint';
  publication?: {
    gitTagPrefix?: string;
    movingTag: string;
  };
  smoke?: ServerSmokeConfiguration;
  environmentSource?: 'declared' | 'provider';
  /**
   * Fingerprint compatibility requires a fingerprint native runtime whose exact full hash equals the OTA runtime.
   */
  runtimeCompatibility?: 'exact' | 'fingerprint';
  /**
   * Source binding explicitly records source validation without asserting an installed native runtime match.
   */
  runtimeBinding?: 'native' | 'source';
  /**
   * A fixed protected environment or a profile-to-environment map; an empty value uses the unapproved boundary.
   */
  approvalEnvironment?:
    | string
    | {
        [k: string]: string;
      };
  signingEnvironment?: string;
  after?: string[];
  profiles?: string[];
  profile?: string;
  channel?: string;
  environment?: string;
  buildGroup?: string;
  image?: string;
  dockerfile?: string;
  easProfile?: string;
  submit?: boolean;
  compareEnvironment?: boolean;
  platforms?: string[];
  submission?: {
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
/**
 * This interface was referenced by `ReleaseConfiguration`'s JSON-Schema
 * via the `definition` "mapping".
 */
export interface JsonMapping {
  file: string;
  pointer: string;
  optional?: boolean;
  codePointer?: string;
  codeType?: 'string';
  mirrors?: JsonMapping[];
  [k: string]: unknown;
}
export interface ServerSmokeConfiguration {
  port: number;
  healthPath: string;
  timeoutSeconds?: number;
  environment?: {
    [k: string]: string;
  };
  services?: {
    [k: string]: {
      image: string;
      environment?: {
        [k: string]: string;
      };
      [k: string]: unknown;
    };
  };
}
/**
 * This interface was referenced by `ReleaseConfiguration`'s JSON-Schema
 * via the `definition` "hook".
 */
export interface Hook {
  /**
   * @minItems 1
   */
  command: [string, ...string[]];
  timeoutMs?: number;
}
export interface PromotionConfiguration {
  /**
   * @minItems 1
   */
  targets: [string, ...string[]];
  tracks: {
    [k: string]: {
      source: string;
      destination: string;
      sourceMarkerPrefix?: string;
      [k: string]: unknown;
    };
  };
  approvalEnvironment: string;
  credentials: PromotionCredentials;
  [k: string]: unknown;
}
export interface PromotionCredentials {
  accessToken?: string;
  serviceAccountBase64?: string;
}
