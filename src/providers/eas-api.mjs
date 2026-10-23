/** @file Read-only EAS evidence unavailable from supported CLI JSON: submission associations, exact OTA assets and signing identity. */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const assert = (condition, message) => { if (!condition) throw new Error(message); };
/** Isolate pinned private SDK access; this adapter cannot enqueue, upload or publish. */
export function createEasEvidence({ location, env, loadModule = name => require(resolve(location(), 'build', name)) }) {
  const sdk = loadModule;
  const client = () => {
    const SessionManager = sdk('user/SessionManager.js').default;
    const session = new SessionManager();
    const accessToken = env.EXPO_TOKEN || session.getAccessToken();
    const sessionSecret = accessToken ? undefined : session.getSessionSecret();
    assert(accessToken || sessionSecret, 'EAS authentication is required.');
    return sdk('commandUtils/context/contextUtils/createGraphqlClient.js').createGraphqlClient({ accessToken, sessionSecret });
  };
  return {
    /** Read fresh build/submission association data using a new GraphQL client. */
    getBuild: id => sdk('graphql/queries/BuildQuery.js').BuildQuery.withSubmissionsByIdAsync(client(), id, { useCache: false }),
    /** Read fresh retry eligibility and the original submitted build. */
    async getSubmission(id) {
      const value = await sdk('graphql/queries/SubmissionQuery.js').SubmissionQuery.byIdWithSubmittedBuildAsync(client(), id);
      const archive = await client().query(`query SubmissionArchive($id: ID!) { submissions { byId(submissionId: $id) { id archiveUrl } } }`,
        { id }, { requestPolicy: 'network-only', noRetry: true }).toPromise();
      assert(!archive.error && archive.data?.submissions?.byId?.id === id, 'Cannot verify the original submitted archive.');
      return { ...value, archiveUrl: archive.data.submissions.byId.archiveUrl };
    },
    /** Read one bounded page of raw update groups without CLI message truncation. */
    listUpdates: (spec, offset) => sdk('graphql/queries/UpdateQuery.js').UpdateQuery.viewUpdateGroupsOnBranchAsync(client(), {
      appId: spec.projectId, branchName: spec.branch.name, offset, limit: 50,
      filter: { platform: spec.platform.toUpperCase(), runtimeVersions: [spec.runtime] },
    }),
    /** Read an exact update group without evaluating application source. */
    getUpdate: id => sdk('graphql/queries/UpdateQuery.js').UpdateQuery.viewUpdateGroupAsync(client(), { groupId: id }),
    /** Resolve provider-supplied download locations; callers must not persist their credentials. */
    assetUrls: (id, keys) => sdk('graphql/queries/AssetQuery.js').AssetQuery.getSignedUrlsAsync(client(), id, keys),
    /** Resolve the channel's single active unconditional branch without changing it. */
    async channel(spec) {
      const value = await sdk('graphql/queries/ChannelQuery.js').ChannelQuery.viewUpdateChannelAsync(client(), { appId: spec.projectId, channelName: spec.channel });
      const mapping = JSON.parse(value.branchMapping);
      assert(!value.isPaused && value.updateBranches.length === 1 && mapping.data?.length === 1 && mapping.data[0].branchMappingLogic === 'true', 'Channel must have one active unconditional branch.');
      const branch = value.updateBranches[0];
      assert(mapping.data[0].branchId === branch.id, 'Channel branch mapping conflicts.');
      return { id: branch.id, name: branch.name };
    },
    /** Obtain readable remote variables; source environment policy is enforced by shared configuration. */
    environment: (projectId, environment) => sdk('graphql/queries/EnvironmentVariablesQuery.js').EnvironmentVariablesQuery.byAppIdWithSensitiveAsync(client(), { appId: projectId, environment, includeFileContent: false }),
    /** Read signing prerequisites in memory; callers must never persist credential responses. */
    async signingCredentials(spec) {
      const result = await client().query(`query Signing($id: String!, $applicationId: String!) { app { byId(appId: $id) {
        androidAppCredentials(filter: { applicationIdentifier: $applicationId, legacyOnly: false }) {
          androidAppBuildCredentialsList { isDefault androidKeystore { id } } googleServiceAccountKeyForSubmissions { id }
        }
        iosAppCredentials { appleAppIdentifier { bundleIdentifier } appStoreConnectApiKeyForSubmissions { id }
          iosAppBuildCredentialsList { iosDistributionType distributionCertificate { id } provisioningProfile { id expiration provisioningProfile } }
        }
      } } }`, { id: spec.projectId, applicationId: spec.applicationId }, { requestPolicy: 'network-only', noRetry: true }).toPromise();
      assert(!result.error && result.data?.app?.byId, 'Cannot verify EAS signing prerequisites.');
      return result.data.app.byId;
    },
    /** Read the default Android keystore without persisting or logging the secret response. */
    async androidCredentials(spec) {
      const response = await client().query(`query AndroidSigning($id: String!, $applicationId: String!) {
        app { byId(appId: $id) { id androidAppCredentials(filter: { applicationIdentifier: $applicationId, legacyOnly: false }) {
          applicationIdentifier androidAppBuildCredentialsList { isDefault androidKeystore { keystore keystorePassword keyAlias keyPassword } }
        } } }
      }`, { id: spec.projectId, applicationId: spec.applicationId }, { requestPolicy: 'network-only', noRetry: true }).toPromise();
      assert(!response.error && response.data?.app?.byId?.id === spec.projectId, 'Cannot read the configured Android signing identity.');
      const apps = response.data.app.byId.androidAppCredentials.filter(item => item.applicationIdentifier === spec.applicationId);
      assert(apps.length === 1, 'Configure Android signing for the exact application ID.');
      const keys = apps[0].androidAppBuildCredentialsList.filter(item => item.isDefault && item.androidKeystore);
      assert(keys.length === 1, 'Configure exactly one default Android keystore.');
      return keys[0].androidKeystore;
    },
    /** Download only the Play key assigned to the exact configured app, without authenticating to Google. */
    async assignedPlayCredentials(spec) {
      const result = await client().query(`query AssignedPlay($id: String!, $applicationId: String!) {
        app { byId(appId: $id) { id androidAppCredentials(filter: {applicationIdentifier: $applicationId, legacyOnly: false}) {
          applicationIdentifier googleServiceAccountKeyForSubmissions { keyJson }
        } } } }`, { id: spec.projectId, applicationId: spec.applicationId }, { requestPolicy: 'network-only', noRetry: true }).toPromise();
      const app = result.data?.app?.byId; const matches = app?.androidAppCredentials;
      assert(!result.error && app?.id === spec.projectId && matches?.length === 1
        && matches[0].applicationIdentifier === spec.applicationId, 'Assigned Play credentials do not match the configured project/application.');
      const value = matches[0].googleServiceAccountKeyForSubmissions;
      if (!value) return null;
      try { return JSON.parse(value.keyJson); } catch { throw new Error('Assigned Play credential is invalid JSON.'); }
    },
    /** Verify the configured Expo project owner and slug against provider identity. */
    async project({ projectId, owner, slug }) {
      const result = await client().query('query Project($id: String!) { app { byId(appId: $id) { id fullName } } }', { id: projectId }, { requestPolicy: 'network-only' }).toPromise();
      assert(!result.error && result.data?.app?.byId?.id === projectId && result.data.app.byId.fullName === `@${owner}/${slug}`, 'Expo project identity differs.');
      return { projectId, owner, slug };
    },
  };
}
