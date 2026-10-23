/** @file Public configuration, hook, planner, environment and transport contracts for the executable shared release package. */
import type { ExecFileSyncOptionsWithStringEncoding, ExecFileSyncOptions } from 'node:child_process';
import type { SourceIdentity, ReleaseGraph, ComponentSelection, StageReceipt, ArtifactManifest, OperationState } from '../packages/release-engine/index.mjs';
export * from '../packages/release-engine/index.mjs';

export type PublicEnvironment = Record<string, string>;
export type ReleaseOrigin = { kind: 'local' } | { kind: 'github'; runId: string; runAttempt: number };
import type { ReleaseConfiguration, TargetConfiguration, JsonMapping, PromotionConfiguration } from './config.d.mts';
export type { ReleaseConfiguration, TargetConfiguration, JsonMapping, PromotionConfiguration } from './config.d.mts';
export interface ComponentObservation {
  id: string; identity: string; compatibilityIdentity?: string; environmentHash?: string | null; fingerprint?: string; runtime?: string;
  version?: string; versionCode?: number; releaseMetadata?: Record<string, unknown>; [key: string]: unknown;
}
export interface ReleaseBaseline {
  components?: Record<string, ComponentObservation | Record<string, unknown>>; runtimes?: Record<string, ComponentObservation | Record<string, unknown>>;
  reservations?: Record<string, { version: string; codes: Record<string, number> }>;
}
export interface PipelinePlan {
  schemaVersion: 1; kind: 'expo-release-plan'; digest: string; source: SourceIdentity; origin: ReleaseOrigin; runId: string;
  config: ReleaseConfiguration; profile: string; operation: string; bump?: string; prepared: boolean;
  components: (TargetConfiguration & { key: string; selected: boolean; identity: string; observation: ComponentObservation; next?: { version: string; versionCode?: number } })[];
  selection: ComponentSelection; graph: ReleaseGraph; stages: Record<string, { action: string; target: string; provider?: string; applicationId?: string; targets?: string[]; promotion?: string }>;
  baseline: ReleaseBaseline; reservations: NonNullable<ReleaseBaseline['reservations']>;
  providerConfiguration: { expo?: ExpoIdentity | null; destinations?: Record<string, Record<string, unknown>> };
  reservationDigest?: string; requestedSource?: SourceIdentity; validatedCandidate?: string;
  retainedOperation?: RetainedOperationRequest;
}
export interface HookResult { schemaVersion: 1; observations?: ComponentObservation[]; artifact?: Record<string, unknown>; [key: string]: unknown }
export interface InspectionRequest {
  root?: string; source: SourceIdentity; profile?: string; environment?: PublicEnvironment; environmentHash?: string | null;
  componentEnvironments?: Record<string, TargetEnvironment>; baseline?: ReleaseBaseline; runtimeOverrides?: Record<string, unknown>;
}
/** Read declarative release configuration from a repository-relative JSON file. */
export function readConfig(root?: string, file?: string): ReleaseConfiguration;
/** Validate a supported configuration without evaluating application code. */
export function validateConfig(config: unknown): ReleaseConfiguration;
/** Resolve a safe relative repository path, rejecting traversal and platform aliases. */
export function repositoryPath(root: string, relative: string): string;
/** Read an own-property JSON pointer or throw for missing fields. */
export function readPointer(value: unknown, pointer: string): unknown;
/** Keep portable toolchain settings plus explicitly approved public inputs. */
export function sourceEnvironment(environment?: NodeJS.ProcessEnv, publicEnvironment?: PublicEnvironment): NodeJS.ProcessEnv;
/** Invoke one JSON application hook with publication credentials removed. */
export function runHook(config: ReleaseConfiguration, action: string, input?: Record<string, unknown>, options?: { root?: string; environment?: NodeJS.ProcessEnv; execute?: (file: string, args: string[], options: ExecFileSyncOptionsWithStringEncoding) => string }): HookResult;
/** Resolve profile defaults into each applicable component. */
export function configuredComponents(config: ReleaseConfiguration, profile?: string): TargetConfiguration[];
/** Identify a component baseline; server history is global across profiles. */
export function baselineKey(component: TargetConfiguration, profile?: string): string;
/** Identify one retained runtime under its platform, profile, channel and environment. */
export function runtimeBaselineKey(component: TargetConfiguration, profile: string, runtime: string): string;
/** Compare source observations with retained successful baselines and seal an immutable release plan. */
export function planRelease(input: { config: ReleaseConfiguration; source: SourceIdentity; origin: ReleaseOrigin; observations: ComponentObservation[]; baseline?: ReleaseBaseline; profile?: string; bump?: string; operation?: string; targets?: string[]; runId?: string; providerConfiguration?: PipelinePlan['providerConfiguration'] }): PipelinePlan;
/** Bind the allocated final source/runtime without rewriting the reservation. */
export function finalizePlan(plan: PipelinePlan, source: SourceIdentity, observations: ComponentObservation[]): PipelinePlan;
/** Carry successful independent components and all version reservations into the next baseline. */
export function completedBaseline(plan: PipelinePlan, receipts: StageReceipt[]): ReleaseBaseline;
/** Read tracked source using Git without shell interpolation. */
export function sourceGit(root: string, args: string[], options?: ExecFileSyncOptions): string;
/** Hash selected tracked source after application-specific normalization. */
export function trackedIdentity(root: string, source: string, options?: { include?: (file: string) => boolean; normalize?: (file: string, text: string) => string }): string;
/** Inspect source through the configured hook and resolve mapped version fields. */
export function inspectSource(config: ReleaseConfiguration, input: InspectionRequest): ComponentObservation[];
/** Verify the package and reusable workflows pin the same full toolkit SHA. */
export function verifyToolkitPins(root: string, options?: { expectedRevision?: string }): string;

export interface ArtifactReceipt { schemaVersion: 1; kind: 'expo-release-artifact'; planDigest: string; target: string; source: SourceIdentity; origin: ReleaseOrigin; producer: { origin: ReleaseOrigin; workflowCommit?: string; toolkitCommit: string }; configuration: string; manifest: ArtifactManifest; metadata: Record<string, unknown> }
/** Record exact artifact bytes and producer identities; a receipt alone authorizes no publication. */
export function createArtifactReceipt(input: { plan: PipelinePlan; target: string; directory: string; metadata?: Record<string, unknown>; origin?: ReleaseOrigin; workflowCommit?: string; toolkitCommit?: string }): Promise<ArtifactReceipt>;

export interface ExpoIdentity { projectId: string; owner: string; slug: string; serverUrl?: string; environmentPolicy?: { allowedNames?: string[]; forbiddenNames?: string[]; channelVariable?: string; readableStringsOnly?: boolean } }
export interface TargetEnvironment { environment: PublicEnvironment; hash: string | null; deferred?: boolean; channel?: string; easEnvironment?: string }
/** Resolve the package's exact pinned EAS executable, independently of consumer/global tooling. */
export function resolveEasCli(): string;
/** Resolve declared JSON mappings recursively without evaluating application code. */
export function resolveConfigurationValue<T = unknown>(value: unknown, root?: string): T;
/** Compare valid semantic versions, including prereleases and arbitrary-sized numeric identifiers; build metadata does not affect precedence. */
export function compareSemver(left: string, right: string): -1 | 0 | 1;
export interface LocalBuildReceipt { kind: 'expo-local-artifacts'; origin: { kind: 'local' }; planDigest: string; plan: PipelinePlan; artifacts: { target: string; directory: string; receipt: ArtifactReceipt }[] }
/** Rehash exact local files and verify their original local plan; the receipt grants no hosted authority. */
export function verifyLocalBuild(file: string): Promise<LocalBuildReceipt>;
/** Write local artifact evidence without granting hosted publication authority. */
export function writeLocalReceipt(root: string, plan: PipelinePlan, artifacts: LocalBuildReceipt['artifacts']): { file: string; receipt: LocalBuildReceipt };

export interface RetainedOperationRequest {
  schemaVersion: 1; kind: 'expo-release-operation'; operation: 'submit' | 'deploy' | 'promote'; digest: string;
  releaseId: string; planDigest: string; configuration: string; targets: string[]; promotion?: string;
  original: { format: 'common' | 'calibrate-v1'; digest: string; source: string; profile: string; origin: ReleaseOrigin };
  artifacts: ({ target: string; receiptDigest: string; inventoryDigest: string; receiptAsset: Record<string, any> }
    | { target: string; metadataDigest: string; sha256: string })[];
}
/** Atomically save one target's external credential paths while preserving original settings and other targets. */
export function saveLocalCredentialPaths(input: { config: ReleaseConfiguration; root: string; target: string; credentialsFile: string; serviceAccountFile?: string; environment?: NodeJS.ProcessEnv; platform?: NodeJS.Platform }): { file: string; settings: Record<string, any>; credentials: { credentialsFile: string; serviceAccountFile?: string } };
/** Install the official locked provider toolchain outside application source. */
export function setupToolchain(): { directory: string; version: string; cached: boolean };
/** Configure external Android signing paths without exposing credential contents. */
export function configureLocalCredentials(input: { config: ReleaseConfiguration; root: string; target?: string; serviceAccountFile?: string; environment?: NodeJS.ProcessEnv }): Promise<{ file: string; target: string; credentialsFile: string; serviceAccountFile?: string }>;
