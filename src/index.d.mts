/** @file Public configuration, hook, planner, environment and transport contracts for the executable shared release package. */
import type { ExecFileSyncOptionsWithStringEncoding, ExecFileSyncOptions } from 'node:child_process';
import type { SourceIdentity, ReleaseGraph, ComponentSelection, StageReceipt, ArtifactManifest, OperationState } from '../packages/release-engine/index.mjs';
export * from '../packages/release-engine/index.mjs';

export type PublicEnvironment = Record<string, string>;
export type ReleaseOrigin = { kind: 'local' } | { kind: 'github'; runId: string; runAttempt: number };
export interface JsonMapping { file: string; pointer: string; optional?: boolean; mirrors?: JsonMapping[]; codePointer?: string; codeType?: 'string' }
export interface ServerSmokeConfiguration {
  port: number; healthPath: string; timeoutSeconds?: number; environment?: PublicEnvironment;
  services?: Record<string, { image: string; environment?: PublicEnvironment }>;
}
export interface PromotionCredentials { accessToken?: string; serviceAccountBase64?: string }
export interface PromotionConfiguration {
  targets: string[]; tracks: Record<string, { source: string; destination: string; sourceMarkerPrefix?: string }>;
  approvalEnvironment: string; credentials: PromotionCredentials;
}
export interface TargetConfiguration {
  id: string; kind: 'server' | 'native' | 'ota'; platform?: 'android' | 'ios'; builder?: 'command' | 'eas'; localBuilder?: 'command' | 'eas';
  appDirectory?: string; version?: JsonMapping; runtimePolicy?: 'appVersion' | 'fingerprint'; runtimeCompatibility?: 'exact' | 'fingerprint'; runtimeBinding?: 'native' | 'source'; nativeTarget?: string;
  profile?: string; profiles?: string[]; channel?: string; environment?: string; submit?: boolean; compareEnvironment?: boolean;
  applicationId?: string; after?: string[]; [key: string]: unknown;
  publication?: { gitTagPrefix: string; movingTag: string };
  smoke?: ServerSmokeConfiguration; environmentSource?: 'declared' | 'provider';
  approvalEnvironment?: string | Record<string, string>; signingEnvironment?: string;
}
export interface ReleaseConfiguration {
  schemaVersion: 1; repository: string; defaultBranch: string; defaultProfile?: string; components: TargetConfiguration[];
  profiles?: Record<string, { easProfile?: string; channel?: string; environment?: string; distribution?: string; submit?: boolean;
    execution?: 'local' | 'hosted'; environmentSource?: 'declared' | 'provider'; publicEnvironment?: PublicEnvironment; expo?: { serverUrl?: string } }>;
  hooks?: Partial<Record<'inspect' | 'prepare' | 'validate' | 'build' | 'verify', { command: string[]; timeoutMs?: number }>>;
  versionGroups?: { id: string; targets: string[]; version?: JsonMapping; bump?: 'requested' | 'patch'; codeAllocation?: 'global' | 'independent'; minimumCode?: number; lanes?: Record<string, { modulus: number; residue: number }>; reusePrepared?: boolean }[];
  nativeGroups?: string[][]; dependencies?: { component: string; requires: string[]; when?: string }[];
  local?: { settingsDirectory?: string; settingsFile?: string; legacyCredentialsField?: string; legacyMetadataFields?: Record<string, 'path' | 'string-map'>; legacyBuildReceiptsField?: string; submissions?: Record<string, { track: string }> ; [key: string]: unknown };
  promotions?: Record<string, PromotionConfiguration>;
  expo?: Record<string, unknown>; inspection?: { environment?: PublicEnvironment }; [key: string]: unknown;
}
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
/** Reserve semantic versions and native codes above all retained attempts. */
export function reserveVersions(config: ReleaseConfiguration, components: TargetConfiguration[], selected: readonly string[], observations: Map<string, ComponentObservation>, baseline: ReleaseBaseline, bump: string): { updates: Record<string, { version: string; versionCode?: number }>; reservations: NonNullable<ReleaseBaseline['reservations']> };
/** Construct supported stage dependencies from configured capabilities. */
export function releaseStages(config: ReleaseConfiguration, components: TargetConfiguration[], selected: readonly string[], operation?: string): Pick<PipelinePlan, 'graph' | 'stages'>;
/** Compare source observations with retained successful baselines and seal an immutable release plan. */
export function planRelease(input: { config: ReleaseConfiguration; source: SourceIdentity; origin: ReleaseOrigin; observations: ComponentObservation[]; baseline?: ReleaseBaseline; profile?: string; bump?: string; operation?: string; targets?: string[]; runId?: string; providerConfiguration?: PipelinePlan['providerConfiguration'] }): PipelinePlan;
/** Bind the allocated final source/runtime without rewriting the reservation. */
export function finalizePlan(plan: PipelinePlan, source: SourceIdentity, observations: ComponentObservation[]): PipelinePlan;
/** Bind validated candidate-tree observations to the exact protected merge without changing workflow/toolkit authority. */
export function bindMergedPlan(reservation: PipelinePlan, prepared: PipelinePlan, source: SourceIdentity): PipelinePlan;
/** Carry successful independent components and all version reservations into the next baseline. */
export function completedBaseline(plan: PipelinePlan, receipts: StageReceipt[]): ReleaseBaseline;
/** Read tracked source using Git without shell interpolation. */
export function sourceGit(root: string, args: string[], options?: ExecFileSyncOptions): string;
/** Hash selected tracked source after application-specific normalization. */
export function trackedIdentity(root: string, source: string, options?: { include?: (file: string) => boolean; normalize?: (file: string, text: string) => string }): string;
/** Inspect source through the configured hook and resolve mapped version fields. */
export function inspectSource(config: ReleaseConfiguration, input: InspectionRequest): ComponentObservation[];
/** Update one declared existing JSON property without constructing new schema paths. */
export function writePointer(value: unknown, pointer: string, next: unknown): void;
/** Apply reserved metadata mappings and the optional application preparation hook. */
export function prepareSource(plan: PipelinePlan, options?: { root?: string; environment?: PublicEnvironment }): { files: string[]; identity: string };
/** Verify the package and reusable workflows pin the same full toolkit SHA. */
export function verifyToolkitPins(root: string, options?: { expectedRevision?: string }): string;

export interface ArtifactReceipt { schemaVersion: 1; kind: 'expo-release-artifact'; planDigest: string; target: string; source: SourceIdentity; origin: ReleaseOrigin; producer: { origin: ReleaseOrigin; workflowCommit?: string; toolkitCommit: string }; configuration: string; manifest: ArtifactManifest; metadata: Record<string, unknown> }
export interface VerifiedSourceProof { readonly schemaVersion: 1; readonly kind: 'verified-artifact-source'; readonly source: string; readonly repository: string; readonly planDigest: string; readonly target: string; readonly origin: ReleaseOrigin; readonly manifestDigest: string; readonly configuration?: string; readonly historical?: boolean }
/** Record exact artifact bytes and producer identities; a receipt alone authorizes no publication. */
export function createArtifactReceipt(input: { plan: PipelinePlan; target: string; directory: string; metadata?: Record<string, unknown>; origin?: ReleaseOrigin; workflowCommit?: string; toolkitCommit?: string }): Promise<ArtifactReceipt>;
/** Verify retained bytes and the original producer, returning an in-process branded source capability. */
export function verifyRetainedArtifact(input: { plan: PipelinePlan; target: string; directory: string; receipt: ArtifactReceipt; verifyProducer?: (receipt: ArtifactReceipt) => Promise<boolean>; verifyAttestation?: (receipt: ArtifactReceipt) => Promise<boolean>; allowLocal?: boolean }): Promise<VerifiedSourceProof>;
/** Verify original hosted provenance and an exact attested file inventory without synthesizing a modern producing plan. */
export function verifyHistoricalArtifact(input: { repository: string; source: string; target: string; origin: ReleaseOrigin; original: unknown; directory: string;
  /** Authenticate the original producer/attestation and return its exact expected files. */
  verifyOriginal: (original: unknown) => Promise<{ path: string; sha256: string }[]> }): Promise<VerifiedSourceProof>;
/** Accept only a live verifier-created proof with matching source and destination identities. */
export function isVerifiedSourceProof(proof: unknown, expected?: { source?: string; target?: string; repository?: string; hosted?: boolean }): proof is VerifiedSourceProof;
/** Write a receipt outside its artifact directory to avoid self-hashing. */
export function saveArtifactReceipt(file: string, receipt: ArtifactReceipt): void;

export interface GitHubApi {
  /** Execute one repository-scoped API request; raw mode returns downloaded bytes. */
  (route: string, options?: { method?: string; body?: unknown; raw?: boolean; upload?: boolean }): Promise<any>;
  /** Read all items from an array-valued paginated endpoint. */
  pages(route: string): Promise<any[]>;
}
/** Create a scoped GitHub client without exposing authentication in arguments or outputs. */
export function githubClient(options: { repository: string; token?: string; request?: typeof fetch }): GitHubApi;
export interface LedgerState { release: Record<string, any>; plan: PipelinePlan | null; events: StageReceipt[]; assets: Record<string, any>[]; legacy?: boolean; baseline?: ReleaseBaseline; [key: string]: unknown }
export interface LegacyReader {
  /** Recognize the original historical format. */
  matches(record: unknown, release: Record<string, any>, config: ReleaseConfiguration): boolean;
  /** Read and verify historical evidence without rewriting its original schema. */
  read(input: { release: Record<string, any>; record: unknown; assets: Record<string, any>[]; api: GitHubApi; config: ReleaseConfiguration }): Promise<LedgerState>;
}
export class GitHubLedger {
  /** Bind the durable release ledger to repository identity and optional producing-run authorization. */
  constructor(options: { config: ReleaseConfiguration; api?: GitHubApi; token?: string; request?: typeof fetch; origin?: ReleaseOrigin; workflowCommit?: string; legacyReaders?: LegacyReader[] });
  /** List common and configured historical records. */
  list(): Promise<Record<string, any>[]>;
  /** Read the immutable plan and append-only events with original-producer verification. */
  read(id: string | number): Promise<LedgerState>;
  /** Reserve a release only from its authorized hosted producer. */
  begin(plan: PipelinePlan): Promise<Record<string, any>>;
  /** Append evidence to an unfinished release before advancing external side effects. */
  append(id: string | number, event: Record<string, unknown>): Promise<Record<string, any>>;
  /** Finish a verified complete or explicitly abandoned common release. */
  finish(id: string | number, options?: { abandon?: boolean }): Promise<Record<string, unknown>>;
  /** Aggregate resolved histories while refusing unfinished candidates. */
  baseline(): Promise<ReleaseBaseline>;
  /** Upload exact immutable bytes, rejecting conflicting retries under the same name. */
  upload(id: string | number, name: string, bytes: Buffer): Promise<Record<string, any>>;
  /** Restore one retained artifact only after its digest verifies. */
  download(asset: Record<string, any>, digest: string, destination: string): Promise<void>;
}
/** Save explicitly local evidence without turning a cache into hosted publication history. */
export function writeLocalReceipt(root: string, plan: PipelinePlan, artifacts: Record<string, unknown>[]): { file: string; receipt: Record<string, unknown> };
export interface ProviderObservation { id: string; status: 'accepted' | 'complete' | 'failed' | 'unknown'; raw?: unknown; reason?: string }
export interface OperationProvider {
  /** Send one authorized request and return its accepted ID before expensive readback. */
  start(context: Record<string, unknown>): Promise<ProviderObservation>;
  /** Observe one exact existing provider ID. */
  status(id: string, context?: Record<string, unknown>): Promise<ProviderObservation>;
  /** Verify observation identity/state and optionally completed artifact bytes. */
  verify(observation: ProviderObservation, context?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Find a unique original response without treating empty search as proof of absence. */
  find?(context?: Record<string, unknown>): Promise<ProviderObservation | null>;
  /** Revalidate an exact provider-supported retry. */
  prepareRetry?(observation: ProviderObservation, context?: Record<string, unknown>): Promise<{ mode: string; proof: Record<string, unknown> }>;
  /** Prove absence using explicit independent reconciliation evidence. */
  verifyAbsence?(evidence: unknown, context?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Verify explicit operator evidence for a provider that cannot query an earlier request. */
  reconcile?(evidence: unknown, context?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Verify a rejected destination against identical artifacts and the already authorized destination. */
  reconcileDestination?(evidence: unknown, context?: Record<string, unknown>): Promise<Record<string, unknown>>;
}
/** Return a stage's latest durable operation, never an earlier success. */
export function latestOperation(events: StageReceipt[], stage: string): OperationState | null;
/** Persist intent before mutation and observe/reconcile without blind retries. */
export function executeOperation(input: { ledger: GitHubLedger; releaseId: string | number; stage: string; provider: OperationProvider; context: Record<string, unknown>; retry?: boolean }): Promise<OperationState>;
/** Record independently verified absence for an unknown request without a known provider ID. */
export function reconcileAbsence(input: { ledger: GitHubLedger; releaseId: string | number; stage: string; provider: OperationProvider; context: Record<string, unknown>; evidence: unknown }): Promise<OperationState>;

export interface ExpoIdentity { projectId: string; owner: string; slug: string; serverUrl?: string; environmentPolicy?: { allowedNames?: string[]; forbiddenNames?: string[]; channelVariable?: string; readableStringsOnly?: boolean } }
export interface TargetEnvironment { environment: PublicEnvironment; hash: string | null; deferred?: boolean; channel?: string; easEnvironment?: string }
export interface ReleaseEnvironment extends TargetEnvironment { expo: ExpoIdentity | null; components: Record<string, TargetEnvironment> }
export interface EasTransport {
  /** Run the pinned provider CLI; false preserves its non-JSON output. */
  cli(args: string[], json?: boolean): any;
  /** Verify exact Expo project ownership. */
  project(spec: ExpoIdentity): Promise<void>;
  /** Read reproducible provider variables without logging them. */
  environment(projectId: string, environment: string): Promise<{ name: string; value: string; type: string; visibility: string }[]>;
  /** Read the exact build and associated submissions. */
  getBuild(id: string): Promise<Record<string, any>>;
  /** Read an exact submission including provider retry eligibility. */
  getSubmission(id: string): Promise<Record<string, any>>;
  /** Read signing prerequisites in memory only. */
  signingCredentials(spec: { projectId: string; applicationId: string }): Promise<Record<string, any>>;
  /** Read the exact default Android key without persisting it. */
  androidCredentials(spec: { projectId: string; applicationId: string }): Promise<Record<string, string>>;
  /** Read the Play key assigned to the exact configured app without authenticating to Google or persisting secrets. */
  assignedPlayCredentials(spec: { projectId: string; applicationId: string }): Promise<Record<string, string> | null>;
  /** Resolve one active unconditional update branch. */
  channel(spec: { projectId: string; channel: string }): Promise<{ id: string; name: string }>;
  /** Read a page of update groups with untruncated operation markers. */
  listUpdates(spec: Record<string, unknown>, offset: number): Promise<Record<string, any>[][]>;
  /** Read an exact update group. */
  getUpdate(id: string): Promise<Record<string, any>[]>;
  /** Resolve temporary authenticated URLs without persisting them. */
  assetUrls(id: string, keys: string[]): Promise<{ storageKey: string; url: string; headers: Record<string, string> }[]>;
  /** Hash downloaded nonempty HTTPS bytes. */
  hashArtifact(url: string, headers?: Record<string, string>): Promise<string>;
  /** Hash a retained local file. */
  hashFile(file: string): Promise<string>;
  /** Hash the exact Expo-exported launcher and assets. */
  exportPayload(directory: string, platform: string): Promise<{ launch: string; assets: string[] }>;
}
/** Resolve provider code relative to this pinned package, never a consumer-installed global CLI. */
export function createEasTransport(options?: { cwd?: string; env?: NodeJS.ProcessEnv; run?: (file: string, args: string[], options: ExecFileSyncOptionsWithStringEncoding) => string; fetch?: typeof fetch }): EasTransport;
/** Resolve the package's exact pinned EAS executable, independently of consumer/global tooling. */
export function resolveEasCli(): string;
/** Write an existing default Android key to an explicit absolute destination; the caller owns secure retention. */
export function downloadEasAndroidCredentials(spec: { projectId: string; applicationId: string }, directory: string, transport?: EasTransport): Promise<string>;
/** Check selected signing prerequisites, profile expiry and required entitlements without changing credentials. */
export function preflightEasSigning(spec: { projectId: string; applicationId: string; platform: string; distribution: string; submit?: boolean; destination?: { ascAppId?: string }; requiredEntitlements?: Record<string, unknown> }, transport?: EasTransport, options?: { now?: number; parseProfile?: (xml: string) => unknown }): Promise<Record<string, unknown>>;
/** Resolve declared JSON mappings recursively without evaluating application code. */
export function resolveConfigurationValue<T = unknown>(value: unknown, root?: string): T;
/** Resolve committed Expo identity, returning null for server-only applications. */
export function resolveExpoConfiguration(config: ReleaseConfiguration, root?: string, profile?: string): ExpoIdentity | null;
/** Read validated public EAS inputs per component outside the source-hook process. */
export function readReleaseEnvironment(config: ReleaseConfiguration, options?: { root?: string; profile?: string; transport?: Pick<EasTransport, 'project' | 'environment'>; environment?: string; targets?: string[]; deferProtected?: boolean }): Promise<ReleaseEnvironment>;
/** Project only original native version fields for a retained runtime export. */
export function baselineRuntimeOverrides(baseline: Record<string, any>): { version: string; androidVersionCode?: number; iosBuildNumber?: string };
/** Verify full fingerprint, environment, ancestry and runtime retirement before using an older native runtime. */
export function verifyCompatibleRuntime(input: { component: TargetConfiguration; baseline: Record<string, any>; observation: ComponentObservation; source: string; profile: string; isAncestor: (ancestor: string, source: string) => Promise<boolean>; retiredRuntimes?: { profile: string; platform: string; runtimeVersion: string }[] }): Promise<Record<string, unknown>>;
/** Compose one EAS stage from sealed provider configuration and original verified retained metadata; caller owns disposal. */
export function createEasStage(input: { action: 'build' | 'handoff' | 'submit' | 'publish'; plan: PipelinePlan; component: string | PipelinePlan['components'][number]; artifact?: { directory: string; receipt: ArtifactReceipt }; sourceProof?: VerifiedSourceProof; environment?: ReleaseEnvironment; transport?: EasTransport; root?: string; providerEnvironment?: NodeJS.ProcessEnv; binding?: OtaRuntimeBinding; operation?: OperationState | null }): Promise<{ spec: Record<string, any>; provider: OperationProvider; preflight?: () => Promise<Record<string, unknown>>;
  /** Remove the data-only publisher workspace; retained artifacts remain caller-owned. */
  dispose(): void;
}>;

export interface OtaRuntimeBinding {
  schemaVersion: 1; kind: 'expo-ota-runtime-binding'; planDigest: string; target: string; nativeTarget: string;
  source: string; profile: string; platform: string; channel: string; environment: string; origin: 'prepared-native' | 'retained-native' | 'source-validated';
  baselineIdentity: string | null; baselineSource: string; key: string; directory: string; runtime: string; version: string; versionCode: number | null;
  fingerprint: string; environmentHash: string; nativeEnvironmentHash: string | null; runtimeOverrides: Record<string, unknown>; expoConfig: Record<string, unknown>;
  observation: ComponentObservation; nativeObservation: ComponentObservation;
  payload?: { launch: string; assets: string[] }; branch?: { id: string; name: string };
}
export interface OtaBindingRequest {
  plan: PipelinePlan; component: string | PipelinePlan['components'][number]; root: string; inputs: ReleaseEnvironment;
  baseline?: Record<string, any>; inspect?: typeof inspectSource; git?: typeof sourceGit;
}
/** Resolve one exact current or retained runtime in a credential-free source phase without altering reservations. */
export function resolveOtaBinding(input: OtaBindingRequest): Promise<OtaRuntimeBinding>;
/** Resolve all compatible nonretired runtimes and retain explicit evidence for skipped or unsupported exports. */
export function resolveOtaBindings(input: OtaBindingRequest): Promise<{ schemaVersion: 1; kind: 'expo-ota-runtime-bindings'; planDigest: string; target: string; bindings: OtaRuntimeBinding[]; skipped: { runtime: string | null; reason: string }[]; noCompatibleRuntime: boolean }>;
/** Validate retained binding membership and native compatibility without reading or executing application source. */
export function verifyOtaBinding(input: { plan: PipelinePlan; component: string | PipelinePlan['components'][number]; binding: OtaRuntimeBinding }): OtaRuntimeBinding;
export interface CloudBuildLease { schemaVersion: 1; kind: 'expo-cloud-build-lease'; id: string; planDigest: string; source: string; target: string; stage: string; origin: ReleaseOrigin }
export interface CloudBuildAccepted { schemaVersion: 1; kind: 'expo-cloud-build-accepted'; lease: CloudBuildLease; id: string }
/** Record a fresh cloud intent before giving its single producer permission to enqueue; existing work is observation-only. */
export function beginCloudBuild(input: { ledger: GitHubLedger; releaseId: string | number; target: string; origin: ReleaseOrigin; retry?: boolean; transport?: EasTransport; providerEnvironment?: NodeJS.ProcessEnv }): Promise<{ mode: 'enqueue'; lease: CloudBuildLease } | { mode: 'observe'; operation: OperationState }>;
/** Enqueue once in the exact source checkout and flush its returned ID before any readback; retain the handoff even on later failure. */
export function enqueueCloudBuild(input: { plan: PipelinePlan; target: string; root: string; inputs: ReleaseEnvironment; lease: CloudBuildLease; origin: ReleaseOrigin; handoffFile: string; transport?: EasTransport; providerEnvironment?: NodeJS.ProcessEnv }): Promise<CloudBuildAccepted>;
/** Observe the retained cloud ID without source execution or enqueue capability, download exact bytes, and seal an artifact for later retention/attestation. */
export function monitorCloudBuild(input: { ledger: GitHubLedger; releaseId: string | number; target: string; accepted?: CloudBuildAccepted; inputs: ReleaseEnvironment; outputRoot: string; origin: ReleaseOrigin; workflowCommit: string; toolkitCommit: string; transport?: EasTransport; providerEnvironment?: NodeJS.ProcessEnv; fetch?: typeof fetch; timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number }): Promise<{ operation: OperationState; artifacts: { target: string; directory: string; receiptFile: string; receipt: ArtifactReceipt; hash: string }[] }>;
export interface BaselineHydrationProviders {
  expo?: ExpoIdentity; eas?: Pick<EasTransport, 'getBuild' | 'hashArtifact'>;
  /** Create a read-only image metadata transport for one configured server. */
  ghcr?: (component: TargetConfiguration) => { inspect(reference: string, options: { includeLabels: boolean }): Promise<Record<string, any> | null> };
  /** Compute application inputs only in a source-only process; never invoke application hooks in a privileged reader. */
  inputIdentity?: (input: { component: TargetConfiguration; source: string }) => string | Promise<string>;
}
/** Verify configured cloud imports and ancestor image tags without ledger writes; existing successful baselines take precedence. */
export function hydrateBaselines(input: { config: ReleaseConfiguration; baseline?: ReleaseBaseline; root?: string; source: Pick<SourceIdentity, 'repository' | 'commit'>; api: GitHubApi; profile?: string; policy?: Record<string, any>; providers?: BaselineHydrationProviders }): Promise<ReleaseBaseline>;
/** Verify one explicit original cloud record against live exact build identity and artifact bytes. */
export function verifyImportedCloudBaseline(input: { config: ReleaseConfiguration; value: Record<string, any>; source: Pick<SourceIdentity, 'repository' | 'commit'>; profile: string; api: GitHubApi; expo: ExpoIdentity; transport: Pick<EasTransport, 'getBuild' | 'hashArtifact'> }): Promise<{ component: TargetConfiguration; value: Record<string, any> }>;
/** Read legacy ancestor image evidence; null means no eligible published image, never a suppressed authorization/network failure. */
export function bootstrapServerBaseline(input: { config: ReleaseConfiguration; component: TargetConfiguration; source: Pick<SourceIdentity, 'repository' | 'commit'>; api: GitHubApi; transport: { inspect(reference: string, options: { includeLabels: boolean }): Promise<Record<string, any> | null> }; inputIdentity?: BaselineHydrationProviders['inputIdentity'] }): Promise<Record<string, any> | null>;

export interface RecoveryRequest {
  action: 'resume' | 'retry' | 'reconcile' | 'abandon' | 'complete'; planDigest?: string; stage?: string;
  operationId?: string; destination?: Record<string, unknown>; absence?: Record<string, unknown>; health?: DeploymentReconciliation; reason?: string;
}
export interface LegacyRecoveryAdapter {
  /** Reverify original provider evidence and append a separately authenticated recovery action. */
  recover(input: { ledger: GitHubLedger; state: LedgerState; request: RecoveryRequest }): Promise<Record<string, any>>;
}
/** Inspect immutable original plans plus canonical stages and every durable provider suboperation. */
export function inspectRecovery(input: { ledger: GitHubLedger; releaseId: string | number }): Promise<Record<string, any>>;
/** Authorize frozen-plan continuation, observe/reconcile exact IDs without enqueue, or close verified complete/abandoned work. */
export function recoverRelease(input: { ledger: GitHubLedger; releaseId: string | number; request: RecoveryRequest; legacyAdapter?: LegacyRecoveryAdapter;
  /** Construct only a trusted source-free provider observer for the recorded operation. */
  providerForStage?: (input: { state: LedgerState; stage: string; operation: OperationState }) => OperationProvider | Promise<OperationProvider>;
}): Promise<Record<string, any>>;
/** Preserve original Little Say journals and verify both historical and separately authenticated recovery producers. */
export function readLittleSayRelease(input: { release: Record<string, any>; record: unknown; assets: Record<string, any>[]; api: GitHubApi; config: ReleaseConfiguration }): Promise<LedgerState>;
export const littleSayLegacyReader: LegacyReader;
/** Append audited evidence without changing original assets, plans, IDs, reservations or provenance. */
export function appendLittleSayRecovery(input: { ledger: GitHubLedger; state: LedgerState; action: RecoveryRequest['action']; evidence: Record<string, unknown>; reason?: string }): Promise<LedgerState>;
export interface LittleSayRecoveryTransports { transport?: EasTransport; registry?: { inspect(reference: string, options: { includeLabels: boolean }): Promise<Record<string, any> | null> } }
/** Read exact original native/image/OTA/submission bytes and job evidence without running source or sending provider writes. */
export function observeLittleSayRelease(input: LittleSayRecoveryTransports & { state: LedgerState; config: ReleaseConfiguration; api: GitHubApi; environment?: NodeJS.ProcessEnv; scope?: 'submit-android' | 'submit-ios' | 'promote-server' | 'ota' }): Promise<Record<string, any>>;
/** Supply the shared historical Little Say recovery contract to recoverRelease. */
export function createLittleSayRecoveryAdapter(options?: LittleSayRecoveryTransports): LegacyRecoveryAdapter;
/** Compare valid semantic versions, including prereleases and arbitrary-sized numeric identifiers; build metadata does not affect precedence. */
export function compareSemver(left: string, right: string): -1 | 0 | 1;
export interface LegacyStageRoute { stage: string; provider: 'expo' | 'image' | 'deploy' | 'repository'; approval: string }
/** Route one explicit historical stage to its own provider credentials and configured protected environment. */
export function routeLittleSayRecovery(state: LedgerState, request: RecoveryRequest, config: ReleaseConfiguration): LegacyStageRoute;
/** Continue only the named retained-evidence stage, persisting separately authenticated reducer transitions before provider writes. */
export function continueLittleSayRelease(input: LittleSayRecoveryTransports & { ledger: GitHubLedger; releaseId: string | number; stage: string; retry?: boolean; environment?: NodeJS.ProcessEnv }): Promise<{ route: LegacyStageRoute; complete: boolean; operation: Record<string, any>; remaining: string[] }>;
export interface LocalBuildReceipt { kind: 'expo-local-artifacts'; origin: { kind: 'local' }; planDigest: string; plan: PipelinePlan; artifacts: { target: string; directory: string; receipt: ArtifactReceipt }[] }
/** Rehash exact local files and verify their original local plan; the receipt grants no hosted authority. */
export function verifyLocalBuild(file: string): Promise<LocalBuildReceipt>;
/** Plan explicitly permitted internal Android submissions from an unchanged retained local build. */
export function localSubmissionPlan(build: LocalBuildReceipt, config: ReleaseConfiguration): PipelinePlan;
/** Execute or resume local-only internal Play submission using an external service-account file and durable local-origin history. */
export function submitLocally(input: { config: ReleaseConfiguration; root: string; receiptFile: string; api: GitHubApi; environment?: NodeJS.ProcessEnv; serviceAccountFile?: string; releaseId?: string | number; action?: 'resume' | 'abandon'; reason?: string }): Promise<Record<string, any>>;

export interface RetainedOperationRequest {
  schemaVersion: 1; kind: 'expo-release-operation'; operation: 'submit' | 'deploy' | 'promote'; digest: string;
  releaseId: string; planDigest: string; configuration: string; targets: string[]; promotion?: string;
  original: { format: 'common' | 'calibrate-v1'; digest: string; source: string; profile: string; origin: ReleaseOrigin };
  artifacts: ({ target: string; receiptDigest: string; inventoryDigest: string; receiptAsset: Record<string, any> }
    | { target: string; metadataDigest: string; sha256: string })[];
}
export interface RetainedOperationRoute { stage: string; provider: 'expo' | 'play' | 'image' | 'deploy'; approval: string; credentials?: PromotionCredentials }
export interface RestoredOperationArtifact { directory: string; receipt?: ArtifactReceipt; sourceProof: VerifiedSourceProof; file?: string; sha256?: string }
export interface PlayCohortTarget {
  target: string; applicationId: string; sourceTrack: string; destination: string; versionCode: number; sha256: string;
  marker: string; sourceMarker?: string; sourceProof: VerifiedSourceProof;
}
export interface PlayTrackRelease { name?: string; status: string; versionCodes: string[] }
export interface PlayCohortPublisher {
  /** Open a temporary edit; callers delete uncommitted edits. */
  createEdit(): Promise<string>;
  /** Discard one uncommitted edit. */
  deleteEdit(editId: string): Promise<unknown>;
  /** Read the track visible inside the edit. */
  getTrack(editId: string, track: string): Promise<{ releases?: PlayTrackRelease[] }>;
  /** Read exact uploaded bundle versions and hashes. */
  listBundles(editId: string): Promise<{ bundles?: { versionCode: number | string; sha256: string }[] }>;
  /** Stage a complete track replacement without committing other targets early. */
  updateTrack(editId: string, track: string, release: PlayTrackRelease): Promise<unknown>;
  /** Commit all staged changes atomically for this application. */
  commitEdit(editId: string): Promise<unknown>;
}
export interface RetainedProviderInput {
  ledger: GitHubLedger; state: LedgerState; stage: string; directory: string; environment?: NodeJS.ProcessEnv; easTransport?: EasTransport;
  /** Restore the original producer's exact verified bytes; the caller owns the directory. */
  restore?: (input: { ledger: GitHubLedger; state: LedgerState; target: string; directory: string }) => Promise<RestoredOperationArtifact>;
  /** Execute the configured single-attempt deployment transport. */
  deploy?: (spec: Record<string, any>, environment: NodeJS.ProcessEnv) => Record<string, unknown>;
  /** Resolve only credentials declared for this named promotion. */
  token?: (credentials: PromotionCredentials, environment: NodeJS.ProcessEnv) => Promise<string>;
  /** Create a publisher for the exact application and scoped token. */
  publisherFactory?: (options: { applicationId: string; accessToken: string }) => PlayCohortPublisher;
}
/** Plan a standalone operation from finalized hosted evidence without changing its artifacts, reservations or producer. */
export function retainedOperationRequest(input: { state: LedgerState; config: ReleaseConfiguration; operation: 'submit' | 'deploy' | 'promote'; targets?: string[]; promotion?: string }): RetainedOperationRequest;
/** Revalidate a retained request and create a new protected operation plan bound to the original artifact source. */
export function prepareRetainedOperation(input: { state: LedgerState; request: RetainedOperationRequest; config: ReleaseConfiguration; source: SourceIdentity; origin: Extract<ReleaseOrigin, { kind: 'github' }>; runId?: string }): PipelinePlan;
/** Select exactly one provider and configured approval boundary for a retained operation. */
export function routeRetainedOperation(plan: PipelinePlan, stage: string): RetainedOperationRoute;
/** Resolve named stage credentials without fallback to unrelated secrets; temporary service-account files are always removed. */
export function resolvePromotionToken(credentials: PromotionCredentials, environment: NodeJS.ProcessEnv,
  resolveToken?: (options: { environment: NodeJS.ProcessEnv; serviceAccountFile?: string }) => Promise<string>): Promise<string>;
/** Verify and restore original hosted artifacts; this operation does not become their producer. */
export function restoreRetainedOperationArtifact(input: { ledger: GitHubLedger; state: LedgerState; target: string; directory: string;
  /** Authenticate the original receipt file against its producing workflow. */
  verifyAttestation?: (input: { api: GitHubApi; config: ReleaseConfiguration; receipt: ArtifactReceipt; file: string }) => Promise<unknown>;
  /** Restore historical artifacts through their original schema and producing-run authority. */
  restoreHistorical?: NonNullable<RetainedProviderInput['restore']>;
}): Promise<RestoredOperationArtifact>;
/** Compose a source-free observer/publisher without starting an operation; callers dispose publisher state and own restored files. */
export function retainedOperationProvider(input: RetainedProviderInput): Promise<{ route: RetainedOperationRoute; provider: OperationProvider;
  /** Remove disposable publisher configuration without deleting caller-owned artifacts. */
  dispose(): void;
}>;
/** Execute or observe a retained stage, preserving durable operation IDs and the original artifact proof. */
export function executeRetainedOperation(input: Omit<RetainedProviderInput, 'state'> & { releaseId: string | number; retry?: boolean; wait?: boolean; registry?: Record<string, any> }): Promise<{ route: RetainedOperationRoute; complete: boolean; operation?: OperationState }>;
/** Promote exact same-app Android targets in one edit; ambiguous or partial outcomes require reconciliation. */
export function createPlayCohortPromotionProvider(spec: { applicationId: string; source: string; repository: string; targets: PlayCohortTarget[] }, publisher: PlayCohortPublisher): OperationProvider;
export interface DeploymentReconciliation {
  confirmed: true; outcome: 'healthy' | 'not-started'; service: string; planDigest: string; operationKey: string; attempt: number;
  evidence: string; observedAt: string; evidenceKind?: 'operator-service-log-reconciliation';
  body?: { service: string; status: 'succeeded'; healthy: true };
}
/** Validate explicit operator service-log evidence for one webhook attempt; health never proves an exact deployed image digest. */
export function verifyDeploymentReconciliation(value: unknown, spec: { service: string }, context: { planDigest: string; operationKey: string; attempt: number },
  outcome: DeploymentReconciliation['outcome']): DeploymentReconciliation & { evidenceKind: 'operator-service-log-reconciliation'; healthy?: true };
/** Atomically save one target's external credential paths while preserving original settings and other targets. */
export function saveLocalCredentialPaths(input: { config: ReleaseConfiguration; root: string; target: string; credentialsFile: string; serviceAccountFile?: string; environment?: NodeJS.ProcessEnv; platform?: NodeJS.Platform }): { file: string; settings: Record<string, any>; credentials: { credentialsFile: string; serviceAccountFile?: string } };
