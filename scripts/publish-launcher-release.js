const fs = require('fs');
const path = require('path');

const { requireNewerSequence } = require('../libs/client-release-publication');
const launcherRelease = require('../libs/launcher-release-publication');
const { verifyReleaseManifest } = require('../libs/release-manifest');
const io = require('../libs/release-publication-io');
const ops = require('../libs/release-store-ops');
const { openStore } = require('../libs/r2-store');

const {
    acquirePublicationLock,
    artifactUrl,
    launcherRoot,
    loadConfiguration
} = io;

const INSTALLER_CONTENT_TYPE = 'application/vnd.microsoft.portable-executable';
const UPDATER_CONTENT_TYPE = 'text/yaml';
const DEFAULT_STAGING_CONFIG = 'config/release-publication.staging.json';

// Seam for tests: the commands reach R2, the network and the clock only through these. `openStore`
// builds the S3 transport; a store opened with `writable: false` cannot write at all, and every
// command that must not write (prepare, verify, any dry run) opens it that way.
const deps = {
    workRoot: path.join(launcherRoot, '.release-work'),
    liveManifest: io.liveManifest,
    fetchResponse: io.fetchResponse,
    openStore
};

const COMMAND_OPTIONS = {
    prepare: ['version', 'candidate', 'validated-sha256', 'staging-candidate', 'staging-config', 'minimum-supported', 'config'],
    'prepare-rollback': ['version', 'source-sequence', 'config'],
    'prepare-withdraw': ['config'],
    stage: ['version', 'sequence', 'withdrawal', 'resume', 'dry-run', 'staging-config', 'config'],
    promote: ['version', 'sequence', 'withdrawal', 'confirm-promote', 'dry-run', 'staging-config', 'config'],
    verify: ['version', 'sequence', 'withdrawal', 'config']
};
const FLAGS = ['withdrawal', 'resume', 'dry-run', 'confirm-promote'];

function usage() {
    return [
        'Usage (run from Microbot-Launcher; all commands default to config/release-publication.staging.json,',
        'use --config config/release-publication.production.json for production):',
        'The sequence of a new release is computed from the live manifest in R2 (live + 1); it is never typed.',
        'prepare prints it, and stage, promote and verify take it back with --sequence to find the bundle.',
        '  node scripts/publish-launcher-release.js prepare --version <v> --candidate <dir> --validated-sha256 <hex>',
        '        [--staging-candidate <dir>  (required for production)] [--minimum-supported <v>] [--staging-config <path>]',
        '  node scripts/publish-launcher-release.js prepare-rollback --version <v> --source-sequence <n>',
        '  node scripts/publish-launcher-release.js prepare-withdraw',
        '  node scripts/publish-launcher-release.js stage   (--version <v> | --withdrawal) --sequence <n> [--resume] [--dry-run]',
        '  node scripts/publish-launcher-release.js promote (--version <v> | --withdrawal) --sequence <n> --confirm-promote [--dry-run]',
        '  node scripts/publish-launcher-release.js verify  (--version <v> | --withdrawal) --sequence <n>'
    ].join('\n');
}

function parseArguments(argv) {
    const [command, ...rest] = argv;
    if (!Object.prototype.hasOwnProperty.call(COMMAND_OPTIONS, command)) throw new Error(usage());
    const options = {};
    for (let index = 0; index < rest.length; index += 1) {
        const token = rest[index];
        if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
        const name = token.slice(2);
        if (!COMMAND_OPTIONS[command].includes(name)) throw new Error(`unknown option for ${command}: ${token}`);
        if (FLAGS.includes(name)) {
            options[name] = true;
            continue;
        }
        const value = rest[index + 1];
        if (!value || value.startsWith('--')) throw new Error(`missing value for ${token}`);
        options[name] = value;
        index += 1;
    }

    const locatesBundle = ['stage', 'promote', 'verify'].includes(command);
    if (locatesBundle) {
        options.sequence = Number(options.sequence);
        if (!Number.isSafeInteger(options.sequence) || options.sequence <= 0) {
            throw new Error('release sequence must be a positive safe integer');
        }
    }
    const needsVersion = ['prepare', 'prepare-rollback'].includes(command) ||
        (['stage', 'promote', 'verify'].includes(command) && !options.withdrawal);
    if (needsVersion) {
        if (!options.version) throw new Error(usage());
        launcherRelease.validateLauncherVersion(options.version);
    }
    if (options.withdrawal && options.version) throw new Error('--withdrawal and --version cannot be combined');
    if (command === 'prepare') {
        if (!options.candidate || !options['validated-sha256']) throw new Error(usage());
        if (!/^[0-9a-f]{64}$/.test(options['validated-sha256'])) {
            throw new Error('--validated-sha256 must be the lowercase SHA-256 recorded for L3');
        }
        if (options['minimum-supported']) launcherRelease.validateLauncherVersion(options['minimum-supported'], '--minimum-supported');
    }
    if (command === 'prepare-rollback') {
        options['source-sequence'] = Number(options['source-sequence']);
        if (!Number.isSafeInteger(options['source-sequence']) || options['source-sequence'] <= 0) {
            throw new Error('prepare-rollback requires a positive --source-sequence');
        }
    }
    return { command, options };
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadStagingConfiguration(options) {
    const staging = loadConfiguration(options['staging-config'] || DEFAULT_STAGING_CONFIG);
    if (staging.channel !== 'staging') throw new Error('--staging-config must be a staging publication configuration');
    return staging;
}

function readBundle(config, options) {
    if (options.withdrawal) {
        const directory = launcherRelease.launcherWithdrawalDirectory(deps.workRoot, config.channel, options.sequence);
        const bundle = launcherRelease.readAndVerifyLauncherWithdrawal({
            outputDirectory: directory,
            channel: config.channel,
            keyId: config.keyId,
            publicKey: config.publicKey
        });
        return { kind: 'withdrawal', directory, base: ops.requireBase(bundle.metadata), ...bundle };
    }
    const directory = launcherRelease.launcherBundleDirectory(
        deps.workRoot,
        config.channel,
        options.version,
        options.sequence
    );
    const bundle = launcherRelease.readAndVerifyLauncherBundle({
        outputDirectory: directory,
        channel: config.channel,
        keyId: config.keyId,
        publicKey: config.publicKey
    });
    return { kind: 'launcher', directory, base: ops.requireBase(bundle.metadata), ...bundle };
}

// The objects a bundle writes, in upload order. The candidate manifest is last: its presence marks
// the bundle as staged.
function bundleObjects(bundle) {
    const objects = [];
    if (bundle.kind === 'launcher') {
        objects.push(
            { name: 'installer', key: bundle.metadata.artifactObjectKey, file: bundle.artifactFile, contentType: INSTALLER_CONTENT_TYPE, reuse: bundle.metadata.reusesArtifact === true },
            { name: 'latest.yml', key: bundle.metadata.updaterObjectKey, file: bundle.updaterFile, contentType: UPDATER_CONTENT_TYPE, reuse: bundle.metadata.reusesArtifact === true }
        );
    }
    objects.push({
        name: 'candidate',
        key: bundle.metadata.candidateObjectKey,
        file: path.join(bundle.directory, 'manifest.json'),
        contentType: 'application/json',
        reuse: false
    });
    return objects;
}

// Every key this release will write is checked before the first write. The bundle metadata is read
// from disk, so a key that does not belong to this release is refused here, not after an upload.
function requireOwnKeys(config, bundle) {
    const context = {
        version: bundle.payload.launcher ? bundle.payload.launcher.version : null,
        sequence: bundle.payload.sequence
    };
    for (const spec of bundleObjects(bundle)) {
        launcherRelease.requireAllowedLauncherWriteKey(config.channel, spec.key, context);
    }
    launcherRelease.requireAllowedLauncherWriteKey(config.channel, bundle.metadata.manifestObjectKey, context);
}

// Fail closed: the installer must not become reachable through an older Worker. A Worker that has
// the authenticated download routes answers an anonymous request with 401 `unauthorized`, and the
// public artifact route must not serve launcher objects. Anything else (404, 200, an error, no
// answer) means this environment is not ready for a launcher manifest.
async function requireSiteRoutes(config) {
    const probe = async (url) => {
        let response;
        try {
            response = await deps.fetchResponse(url, { cache: 'no-store', headers: { Accept: 'application/json' } });
        } catch (error) {
            throw new Error(`could not check the launcher download routes of ${config.channel}: ${error.message}`);
        }
        let code = null;
        try {
            code = (await response.json())?.error?.code ?? null;
        } catch (_) {
            code = null;
        }
        return { status: response.status, code };
    };

    const download = await probe(new URL('downloads/launcher', config.publicBaseUrl).toString());
    if (download.status !== 401 || download.code !== 'unauthorized') {
        throw new Error(
            `the ${config.channel} Worker does not have the authenticated launcher download routes ` +
            `(anonymous request answered HTTP ${download.status}${download.code ? ` ${download.code}` : ''}); ` +
            'deploy it before publishing a launcher'
        );
    }
    const closed = await probe(new URL('releases/artifacts/launcher/0.0.0/windows/Microbot-Cut-Launcher-Setup-0.0.0.exe', config.publicBaseUrl).toString());
    if (closed.status !== 404 || closed.code !== 'release_not_found') {
        throw new Error(
            `the ${config.channel} public artifact route does not answer 404 release_not_found for launcher objects ` +
            `(HTTP ${closed.status}${closed.code ? ` ${closed.code}` : ''}); the installer could become public`
        );
    }
}

// Everything that has to hold against the live manifest for this bundle to be published now. The
// bundle must still be based on the live manifest (same ETag); the other checks then explain, in
// release terms, what the manifest and the bundle disagree about.
async function checkAgainstLive(config, options, bundle, live) {
    ops.requireLiveMatchesBase(live, bundle.base);
    const current = live && live.payload;
    requireNewerSequence(bundle.payload, current);
    launcherRelease.requireLauncherReleaseKeepsClient(bundle.payload, current);
    if (bundle.kind === 'launcher' && !bundle.metadata.reusesArtifact) {
        launcherRelease.requireNewerLauncherVersion(bundle.payload, current);
        if (config.channel === 'production') {
            const stagingLive = await deps.liveManifest(loadStagingConfiguration(options), { allowMissing: true });
            launcherRelease.requireStagingPublished(stagingLive, bundle.metadata.stagingCandidate);
        }
    }
}

// The state every prepare is based on: the live manifest in R2 itself, with its ETag. The next
// sequence is computed from it. A launcher needs the client entry the manifest already has.
async function prepareContext(config) {
    const store = deps.openStore(config, { writable: false });
    const live = await ops.readLiveManifest(store, config);
    if (!live) {
        throw new Error('this channel has no live manifest; publish a client release first (the manifest requires a client entry)');
    }
    const { sequence, skipped } = await ops.nextFreeSequence(store, config.channel, live);
    return { live, sequence, skipped, store };
}

// `latest.yml` carries a release date and is immutable once staged under its version. A release that
// was staged and abandoned leaves its `latest.yml` behind, and a new prepare of the same installer
// would stamp a new date and be refused at stage as "differs". The date of the staged file is reused
// when it belongs to exactly this installer, so the re-prepared bundle matches what is already there.
// A staged file for other bytes is ignored here and refused at stage, as it must be.
async function stagedReleaseDate(store, version, sha512Base64) {
    const staged = await store.get(launcherRelease.launcherObjectKeys(version).updater);
    if (!staged.found) return null;
    try {
        const parsed = launcherRelease.parseUpdaterMetadata(staged.bytes.toString('utf8'));
        return parsed.version === version && parsed.sha512 === sha512Base64 ? parsed.releaseDate : null;
    } catch (_) {
        return null;
    }
}

function recordBaseOrDiscard(directory, live) {
    try {
        ops.recordBase(directory, live);
    } catch (error) {
        fs.rmSync(directory, { recursive: true, force: true });
        throw error;
    }
}

const baseLine = (live, sequence, skipped = []) =>
    `Sequence: ${sequence} (live sequence ${live.payload.sequence} + 1` +
    `${skipped.length ? `, skipping ${skipped.join(', ')}: a candidate is already staged in R2` : ''})\n` +
    `Based on live ETag: ${live.etag}\n`;

async function prepare(config, options) {
    const candidateDirectory = path.resolve(launcherRoot, options.candidate);
    const candidate = readJson(path.join(candidateDirectory, 'candidate.json'));
    const installerPath = path.join(candidateDirectory, candidate.file);
    let stagingCandidate = null;
    if (config.channel === 'production') {
        if (!options['staging-candidate']) throw new Error('a production launcher requires --staging-candidate');
        const stagingDirectory = path.resolve(launcherRoot, options['staging-candidate']);
        stagingCandidate = readJson(path.join(stagingDirectory, 'candidate.json'));
        // The staging evidence must itself be an untouched staging build of this release.
        launcherRelease.verifyLauncherCandidate({
            candidate: stagingCandidate,
            installerPath: path.join(stagingDirectory, stagingCandidate.file),
            channel: 'staging',
            version: options.version
        });
    }

    const { live, sequence, skipped, store } = await prepareContext(config);
    launcherRelease.requireNewerLauncherVersion({ launcher: { version: options.version } }, live.payload);
    if (stagingCandidate) {
        const stagingLive = await deps.liveManifest(loadStagingConfiguration(options), { allowMissing: true });
        launcherRelease.requireStagingPublished(stagingLive, stagingCandidate);
    }

    let minimumSupportedVersion = options['minimum-supported'];
    let minimumSource = '--minimum-supported';
    if (!minimumSupportedVersion && config.minimumSupportedLauncherVersion) {
        minimumSupportedVersion = config.minimumSupportedLauncherVersion;
        minimumSource = 'minimumSupportedLauncherVersion in the configuration';
    }
    if (!minimumSupportedVersion) {
        minimumSupportedVersion = config.minimumLauncherVersion;
        minimumSource = 'minimumLauncherVersion in the configuration (the client minimum)';
    }

    const outputDirectory = launcherRelease.launcherBundleDirectory(
        deps.workRoot,
        config.channel,
        options.version,
        sequence
    );
    const releaseDate = await stagedReleaseDate(store, options.version, candidate.sha512Base64);
    const result = launcherRelease.prepareLauncherRelease({
        installerPath,
        ...(releaseDate ? { releaseDate } : {}),
        outputDirectory,
        channel: config.channel,
        version: options.version,
        minimumSupportedVersion,
        sequence,
        currentClient: live.payload.client,
        keyId: config.keyId,
        privateKeyPem: fs.readFileSync(config.privateKeyPath, 'utf8'),
        publicKey: config.publicKey,
        candidate,
        stagingCandidate,
        validatedSha256: options['validated-sha256']
    });
    recordBaseOrDiscard(outputDirectory, live);
    const entry = result.payload.launcher.platforms[launcherRelease.LAUNCHER_PLATFORM];
    process.stdout.write(
        `Prepared launcher ${options.version} for ${config.channel}\n` +
        baseLine(live, sequence, skipped) +
        `Size: ${entry.size} bytes\n` +
        `SHA-256: ${entry.sha256}\n` +
        `Source commit: ${candidate.sourceCommit}\n` +
        `Minimum supported launcher: ${minimumSupportedVersion} (from ${minimumSource})\n` +
        `Client entry carried over: ${live.payload.client.version}\n` +
        (releaseDate ? 'latest.yml reuses the release date of the one already staged in R2 for this installer\n' : '') +
        `Bundle: ${outputDirectory}\n`
    );
}

async function prepareRollback(config, options) {
    const { live, sequence, skipped } = await prepareContext(config);
    const outputDirectory = launcherRelease.launcherBundleDirectory(deps.workRoot, config.channel, options.version, sequence);
    const result = launcherRelease.prepareLauncherRollback({
        sourceDirectory: launcherRelease.launcherBundleDirectory(deps.workRoot, config.channel, options.version, options['source-sequence']),
        outputDirectory,
        channel: config.channel,
        sequence,
        currentClient: live.payload.client,
        keyId: config.keyId,
        privateKeyPem: fs.readFileSync(config.privateKeyPath, 'utf8'),
        publicKey: config.publicKey
    });
    recordBaseOrDiscard(outputDirectory, live);
    process.stdout.write(
        `Prepared launcher rollback to ${options.version}\n` +
        baseLine(live, sequence, skipped) +
        `Reused sequence: ${result.source.payload.sequence}\n` +
        `Client entry carried over: ${live.payload.client.version}\n` +
        'It does not downgrade launchers that are already installed; it changes what the Download page serves.\n'
    );
}

async function prepareWithdraw(config, options) {
    const { live, sequence, skipped } = await prepareContext(config);
    const outputDirectory = launcherRelease.launcherWithdrawalDirectory(deps.workRoot, config.channel, sequence);
    launcherRelease.prepareLauncherWithdrawal({
        outputDirectory,
        channel: config.channel,
        sequence,
        currentClient: live.payload.client,
        keyId: config.keyId,
        privateKeyPem: fs.readFileSync(config.privateKeyPath, 'utf8'),
        publicKey: config.publicKey
    });
    recordBaseOrDiscard(outputDirectory, live);
    process.stdout.write(
        'Prepared launcher withdrawal: the Download page will report the installer as unavailable.\n' +
        baseLine(live, sequence, skipped)
    );
}

function describe(bundle, options) {
    return bundle.kind === 'withdrawal' ? 'launcher withdrawal' : `launcher ${options.version}`;
}

async function stage(config, options) {
    const bundle = readBundle(config, options);
    requireOwnKeys(config, bundle);
    if (bundle.metadata.sourceDirty) {
        throw new Error('refusing to stage a release prepared from an uncommitted working tree');
    }
    if (bundle.kind === 'launcher' && !bundle.metadata.reusesArtifact && bundle.metadata.size > ops.MAX_SINGLE_PUT_BYTES) {
        throw new Error(`the installer is larger than the ${ops.MAX_SINGLE_PUT_BYTES}-byte single-request upload limit`);
    }
    const dryRun = Boolean(options['dry-run']);
    const store = deps.openStore(config, { writable: !dryRun });
    const report = [];
    const live = await ops.readLiveManifest(store, config);
    await checkAgainstLive(config, options, bundle, live);
    await requireSiteRoutes(config);
    for (const spec of bundleObjects(bundle)) {
        const result = await ops.putImmutable(store, {
            key: spec.key,
            file: spec.file,
            contentType: spec.contentType,
            name: spec.name,
            resume: Boolean(options.resume),
            reuse: spec.reuse,
            dryRun
        });
        const verb = { verified: 'verified existing', uploaded: 'uploaded and verified', 'would-upload': 'would upload' }[result.action];
        report.push(`${verb} ${spec.name}: ${spec.key} (${result.size} bytes)`);
    }
    process.stdout.write(`${report.join('\n')}\n`);
    process.stdout.write(dryRun
        ? 'Dry run: nothing was written to R2.\n'
        : `Staged immutable ${describe(bundle, options)} sequence ${options.sequence}; the live channel was not changed.\n`);
}

// The public manifest and, for a launcher, the authoritative R2 objects, must all match the bundle.
async function verifyPublicRelease(config, bundle, store, { checkObjects }) {
    const current = await deps.liveManifest(config);
    if (launcherRelease.canonicalJson(current) !== launcherRelease.canonicalJson(bundle.payload)) {
        throw new Error('public manifest does not match the selected release bundle');
    }
    if (bundle.kind !== 'launcher') return current;
    const entry = bundle.payload.launcher.platforms[launcherRelease.LAUNCHER_PLATFORM];
    const head = await deps.fetchResponse(artifactUrl(config, entry.artifactPath), { method: 'HEAD', cache: 'no-store' });
    if (head.status !== 404) {
        throw new Error(`the launcher installer is publicly reachable (HTTP ${head.status}); it must only be served by the authenticated route`);
    }
    if (checkObjects) {
        for (const spec of bundleObjects(bundle).slice(0, 2)) {
            const remote = await store.get(spec.key);
            if (!remote.found) throw new Error(`R2 object ${spec.key} is missing`);
            if (!ops.sameBytes(remote.bytes, fs.readFileSync(spec.file))) {
                throw new Error(`R2 object ${spec.key} does not match the release bundle`);
            }
        }
    }
    return current;
}

async function promote(config, options) {
    const dryRun = Boolean(options['dry-run']);
    if (!dryRun && !options['confirm-promote']) throw new Error('promotion requires --confirm-promote');
    const bundle = readBundle(config, options);
    requireOwnKeys(config, bundle);
    const store = deps.openStore(config, { writable: !dryRun });
    await requireSiteRoutes(config);
    const live = await ops.readLiveManifest(store, config);
    await checkAgainstLive(config, options, bundle, live);

    // 1. Every launcher object is in R2 with the exact bytes of the bundle.
    for (const spec of bundleObjects(bundle).slice(0, -1)) {
        const remote = await store.get(spec.key);
        if (!remote.found) throw new Error(`${spec.name} is not staged in R2: ${spec.key}`);
        if (!ops.sameBytes(remote.bytes, fs.readFileSync(spec.file))) {
            throw new Error(`staged ${spec.name} does not match the local release bundle`);
        }
    }

    // 2. The staged candidate manifest is the signed manifest of this bundle. Its bytes, read back
    // from R2, are what is written to the live key.
    const staged = await store.get(bundle.metadata.candidateObjectKey);
    if (!staged.found) throw new Error('candidate manifest is not staged');
    const candidateEnvelope = JSON.parse(staged.bytes.toString('utf8'));
    const candidatePayload = verifyReleaseManifest(candidateEnvelope, {
        expectedChannel: config.channel,
        trustedKeys: { [config.keyId]: config.publicKey }
    });
    if (
        candidatePayload.sequence !== bundle.payload.sequence ||
        launcherRelease.canonicalJson(candidateEnvelope) !== launcherRelease.canonicalJson(bundle.envelope)
    ) {
        throw new Error('staged candidate does not match the local release bundle');
    }

    if (dryRun) {
        process.stdout.write(
            `Dry run: ${describe(bundle, options)} sequence ${options.sequence} passed every check; ` +
            `it would replace ${live ? `live sequence ${live.payload.sequence}` : 'a missing manifest'} on ${config.channel}, ` +
            `written only if the live ETag is still ${bundle.base.etag}. Nothing was written.\n`
        );
        return;
    }

    // 3. The only write that changes what users see. It carries If-Match with the ETag of the manifest
    // this bundle was prepared against, so R2 itself refuses it if anything else was published since.
    // A conflict stops here: it is not retried and nothing is overwritten.
    try {
        await ops.promoteManifest(store, config, { bytes: staged.bytes, base: bundle.base });
    } catch (error) {
        if (error instanceof ops.PublicationConflictError || error instanceof ops.WriteNotAppliedError) throw error;
        throw new Error(
            `${error.message}. The manifest write was attempted and the release may already be live. ` +
            'Run verify. To revert, prepare a rollback or a withdrawal (a higher sequence); never lower the sequence.'
        );
    }

    // 4. The public edge serves what R2 now holds.
    try {
        await verifyPublicRelease(config, bundle, store, { checkObjects: false });
    } catch (error) {
        throw new Error(
            `${error.message}. The manifest was written and the release is live in R2. ` +
            'Run verify (the public edge caches the manifest for up to a minute). To revert, prepare a rollback or a withdrawal (a higher sequence); never lower the sequence.'
        );
    }
    process.stdout.write(`Promoted ${describe(bundle, options)} sequence ${options.sequence} to ${config.channel}.\n`);
}

async function verify(config, options) {
    const bundle = readBundle(config, options);
    await verifyPublicRelease(config, bundle, deps.openStore(config, { writable: false }), { checkObjects: true });
    process.stdout.write(
        `Verified ${config.channel} ${describe(bundle, options)} sequence ${options.sequence}: manifest, R2 objects and closed public prefix.\n` +
        'The authenticated download itself needs a signed-in session and is checked in the browser.\n'
    );
}

async function main(argv = process.argv.slice(2)) {
    const { command, options } = parseArguments(argv);
    const config = loadConfiguration(options.config);
    if (command === 'prepare') return prepare(config, options);
    if (command === 'prepare-rollback') return prepareRollback(config, options);
    if (command === 'prepare-withdraw') return prepareWithdraw(config, options);
    if (command === 'verify') return verify(config, options);
    const run = command === 'stage' ? stage : promote;
    // A dry run writes nothing and so needs no lock; its store is opened read-only.
    if (options['dry-run']) return run(config, options);
    // The lock keeps two publications of this machine apart. Across machines the ETag condition on
    // every write is what protects the channel.
    const release = acquirePublicationLock(deps.workRoot, config.channel, `launcher ${command} ${options.version || 'withdrawal'}`);
    try {
        return await run(config, options);
    } finally {
        release();
    }
}

if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = {
    deps,
    main,
    parseArguments,
    prepare,
    prepareRollback,
    prepareWithdraw,
    promote,
    requireSiteRoutes,
    stage,
    verify
};
