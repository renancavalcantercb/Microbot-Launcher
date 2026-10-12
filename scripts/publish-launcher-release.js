const fs = require('fs');
const os = require('os');
const path = require('path');

const { requireNewerSequence, sha256File } = require('../libs/client-release-publication');
const launcherRelease = require('../libs/launcher-release-publication');
const { verifyReleaseManifest } = require('../libs/release-manifest');
const io = require('../libs/release-publication-io');

const {
    MAX_WRANGLER_UPLOAD_BYTES,
    acquirePublicationLock,
    artifactUrl,
    launcherRoot,
    loadConfiguration
} = io;

const INSTALLER_CONTENT_TYPE = 'application/vnd.microsoft.portable-executable';
const UPDATER_CONTENT_TYPE = 'text/yaml';
const DEFAULT_STAGING_CONFIG = 'config/release-publication.staging.json';

// Seam for tests: the commands reach R2, the network and the clock only through these. Nothing in
// this file spawns wrangler or fetches a URL by itself.
const deps = {
    workRoot: path.join(launcherRoot, '.release-work'),
    liveManifest: io.liveManifest,
    fetchResponse: io.fetchResponse,
    r2Get: io.r2Get,
    r2Put: io.r2Put
};

const COMMAND_OPTIONS = {
    prepare: ['version', 'sequence', 'candidate', 'validated-sha256', 'staging-candidate', 'staging-config', 'minimum-supported', 'config'],
    'prepare-rollback': ['version', 'sequence', 'source-sequence', 'config'],
    'prepare-withdraw': ['sequence', 'config'],
    stage: ['version', 'sequence', 'withdrawal', 'resume', 'dry-run', 'staging-config', 'config'],
    promote: ['version', 'sequence', 'withdrawal', 'confirm-promote', 'dry-run', 'staging-config', 'config'],
    verify: ['version', 'sequence', 'withdrawal', 'config']
};
const FLAGS = ['withdrawal', 'resume', 'dry-run', 'confirm-promote'];

function usage() {
    return [
        'Usage (run from Microbot-Launcher; all commands default to config/release-publication.staging.json,',
        'use --config config/release-publication.production.json for production):',
        '  node scripts/publish-launcher-release.js prepare --version <v> --sequence <n> --candidate <dir> --validated-sha256 <hex>',
        '        [--staging-candidate <dir>  (required for production)] [--minimum-supported <v>] [--staging-config <path>]',
        '  node scripts/publish-launcher-release.js prepare-rollback --version <v> --source-sequence <n> --sequence <next>',
        '  node scripts/publish-launcher-release.js prepare-withdraw --sequence <next>',
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

    options.sequence = Number(options.sequence);
    if (!Number.isSafeInteger(options.sequence) || options.sequence <= 0) {
        throw new Error('release sequence must be a positive safe integer');
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
        if (options.sequence <= options['source-sequence']) {
            throw new Error('rollback sequence must be greater than source sequence');
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
        return {
            kind: 'withdrawal',
            directory,
            ...launcherRelease.readAndVerifyLauncherWithdrawal({
                outputDirectory: directory,
                channel: config.channel,
                keyId: config.keyId,
                publicKey: config.publicKey
            })
        };
    }
    const directory = launcherRelease.launcherBundleDirectory(
        deps.workRoot,
        config.channel,
        options.version,
        options.sequence
    );
    return {
        kind: 'launcher',
        directory,
        ...launcherRelease.readAndVerifyLauncherBundle({
            outputDirectory: directory,
            channel: config.channel,
            keyId: config.keyId,
            publicKey: config.publicKey
        })
    };
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

function sameFile(left, right) {
    return fs.statSync(left).size === fs.statSync(right).size && sha256File(left) === sha256File(right);
}

// The live manifest is read from R2 itself (the authority the Worker reads), never through the edge,
// and verified against the channel key.
function readLiveFromR2(config, temporaryDirectory, label) {
    const destination = path.join(temporaryDirectory, `live-${label}.json`);
    const manifestKey = `releases/${config.channel}/manifest.json`;
    if (!deps.r2Get(config, manifestKey, destination, { allowMissing: true })) return null;
    const bytes = fs.readFileSync(destination);
    const envelope = JSON.parse(bytes.toString('utf8'));
    const payload = verifyReleaseManifest(envelope, {
        expectedChannel: config.channel,
        trustedKeys: { [config.keyId]: config.publicKey }
    });
    return { bytes, envelope, payload };
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

// Everything that has to hold against the live manifest for this bundle to be published now.
async function checkAgainstLive(config, options, bundle, current) {
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

async function prepareContext(config) {
    const live = await deps.liveManifest(config, { allowMissing: true });
    if (!live) {
        throw new Error('this channel has no live manifest; publish a client release first (the manifest requires a client entry)');
    }
    return live;
}

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

    const live = await prepareContext(config);
    requireNewerSequence({ sequence: options.sequence }, live);
    launcherRelease.requireNewerLauncherVersion({ launcher: { version: options.version } }, live);
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
        options.sequence
    );
    const result = launcherRelease.prepareLauncherRelease({
        installerPath,
        outputDirectory,
        channel: config.channel,
        version: options.version,
        minimumSupportedVersion,
        sequence: options.sequence,
        currentClient: live.client,
        keyId: config.keyId,
        privateKeyPem: fs.readFileSync(config.privateKeyPath, 'utf8'),
        publicKey: config.publicKey,
        candidate,
        stagingCandidate,
        validatedSha256: options['validated-sha256']
    });
    const entry = result.payload.launcher.platforms[launcherRelease.LAUNCHER_PLATFORM];
    process.stdout.write(
        `Prepared launcher ${options.version} sequence ${options.sequence} for ${config.channel}\n` +
        `Size: ${entry.size} bytes\n` +
        `SHA-256: ${entry.sha256}\n` +
        `Source commit: ${candidate.sourceCommit}\n` +
        `Minimum supported launcher: ${minimumSupportedVersion} (from ${minimumSource})\n` +
        `Client entry carried over: ${live.client.version}\n` +
        `Bundle: ${outputDirectory}\n`
    );
}

async function prepareRollback(config, options) {
    const live = await prepareContext(config);
    requireNewerSequence({ sequence: options.sequence }, live);
    const result = launcherRelease.prepareLauncherRollback({
        sourceDirectory: launcherRelease.launcherBundleDirectory(deps.workRoot, config.channel, options.version, options['source-sequence']),
        outputDirectory: launcherRelease.launcherBundleDirectory(deps.workRoot, config.channel, options.version, options.sequence),
        channel: config.channel,
        sequence: options.sequence,
        currentClient: live.client,
        keyId: config.keyId,
        privateKeyPem: fs.readFileSync(config.privateKeyPath, 'utf8'),
        publicKey: config.publicKey
    });
    process.stdout.write(
        `Prepared launcher rollback to ${options.version} at sequence ${options.sequence}\n` +
        `Reused sequence: ${result.source.payload.sequence}\n` +
        `Client entry carried over: ${live.client.version}\n` +
        'It does not downgrade launchers that are already installed; it changes what the Download page serves.\n'
    );
}

async function prepareWithdraw(config, options) {
    const live = await prepareContext(config);
    requireNewerSequence({ sequence: options.sequence }, live);
    launcherRelease.prepareLauncherWithdrawal({
        outputDirectory: launcherRelease.launcherWithdrawalDirectory(deps.workRoot, config.channel, options.sequence),
        channel: config.channel,
        sequence: options.sequence,
        currentClient: live.client,
        keyId: config.keyId,
        privateKeyPem: fs.readFileSync(config.privateKeyPath, 'utf8'),
        publicKey: config.publicKey
    });
    process.stdout.write(
        `Prepared launcher withdrawal at sequence ${options.sequence}: the Download page will report the installer as unavailable.\n`
    );
}

// An immutable object is written once. R2 does not enforce that for wrangler uploads, so the object
// is looked up first, written only when absent, and always read back and compared byte for byte.
function ensureObject(config, options, temporaryDirectory, spec, report) {
    const existing = path.join(temporaryDirectory, `existing-${spec.name}`);
    if (deps.r2Get(config, spec.key, existing, { allowMissing: true })) {
        if (!sameFile(existing, spec.file)) {
            throw new Error(`R2 object ${spec.key} differs from the local bundle; it is never overwritten`);
        }
        if (!spec.reuse && !options.resume) {
            throw new Error(`immutable object already exists in R2: ${spec.key}; use --resume only to verify it`);
        }
        report.push(`verified existing ${spec.name}: ${spec.key}`);
        return;
    }
    if (spec.reuse) throw new Error(`known-good launcher object is no longer available in R2: ${spec.key}`);
    const size = fs.statSync(spec.file).size;
    if (options['dry-run']) {
        report.push(`would upload ${spec.name}: ${spec.key} (${size} bytes)`);
        return;
    }
    deps.r2Put(config, spec.key, spec.file, spec.contentType);
    const readback = path.join(temporaryDirectory, `readback-${spec.name}`);
    if (!deps.r2Get(config, spec.key, readback, { allowMissing: true })) {
        throw new Error(`R2 object ${spec.key} is missing right after the upload`);
    }
    if (!sameFile(readback, spec.file)) {
        throw new Error(
            `R2 read-back of ${spec.key} failed size or SHA-256 verification. The object was left in place and ` +
            'must not be used; the manifest was not changed. Investigate, then publish under a new version.'
        );
    }
    report.push(`uploaded and verified ${spec.name}: ${spec.key} (${size} bytes)`);
}

async function stage(config, options) {
    const bundle = readBundle(config, options);
    requireOwnKeys(config, bundle);
    if (bundle.metadata.sourceDirty) {
        throw new Error('refusing to stage a release prepared from an uncommitted working tree');
    }
    if (bundle.kind === 'launcher' && !bundle.metadata.reusesArtifact && bundle.metadata.size > MAX_WRANGLER_UPLOAD_BYTES) {
        throw new Error(`the installer is larger than the ${MAX_WRANGLER_UPLOAD_BYTES}-byte limit of wrangler uploads`);
    }
    const report = [];
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'microbot-cut-launcher-stage-'));
    try {
        const live = readLiveFromR2(config, temporaryDirectory, 'stage');
        await checkAgainstLive(config, options, bundle, live && live.payload);
        await requireSiteRoutes(config);
        for (const spec of bundleObjects(bundle)) {
            ensureObject(config, options, temporaryDirectory, spec, report);
        }
    } finally {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
    process.stdout.write(`${report.join('\n')}\n`);
    process.stdout.write(options['dry-run']
        ? 'Dry run: nothing was written to R2.\n'
        : `Staged immutable ${describe(bundle, options)} sequence ${options.sequence}; the live channel was not changed.\n`);
}

function describe(bundle, options) {
    return bundle.kind === 'withdrawal' ? 'launcher withdrawal' : `launcher ${options.version}`;
}

// The public manifest and, for a launcher, the authoritative R2 objects, must all match the bundle.
async function verifyPublicRelease(config, bundle, temporaryDirectory, { checkObjects }) {
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
            const readback = path.join(temporaryDirectory, `verify-${spec.name}`);
            if (!deps.r2Get(config, spec.key, readback, { allowMissing: true })) {
                throw new Error(`R2 object ${spec.key} is missing`);
            }
            if (!sameFile(readback, spec.file)) {
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
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'microbot-cut-launcher-promote-'));
    try {
        await requireSiteRoutes(config);
        const first = readLiveFromR2(config, temporaryDirectory, 'first');
        await checkAgainstLive(config, options, bundle, first && first.payload);

        // 1. Every launcher object is in R2 with the exact bytes of the bundle.
        const objects = bundleObjects(bundle);
        for (const spec of objects.slice(0, -1)) {
            const readback = path.join(temporaryDirectory, `object-${spec.name}`);
            if (!deps.r2Get(config, spec.key, readback, { allowMissing: true })) {
                throw new Error(`${spec.name} is not staged in R2: ${spec.key}`);
            }
            if (!sameFile(readback, spec.file)) {
                throw new Error(`staged ${spec.name} does not match the local release bundle`);
            }
        }

        // 2. The staged candidate manifest is the signed manifest of this bundle. Its bytes, read
        // back from R2, are what is written to the live key.
        const candidate = path.join(temporaryDirectory, 'candidate.json');
        if (!deps.r2Get(config, bundle.metadata.candidateObjectKey, candidate, { allowMissing: true })) {
            throw new Error('candidate manifest is not staged');
        }
        const candidateEnvelope = readJson(candidate);
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

        // 3. Last look: the live manifest must be byte-identical to the one every check used.
        const second = readLiveFromR2(config, temporaryDirectory, 'second');
        const unchanged = (first === null && second === null) ||
            (first !== null && second !== null && Buffer.compare(first.bytes, second.bytes) === 0);
        if (!unchanged) {
            throw new Error('the live manifest changed during the promotion; nothing was written. Check what was published, then prepare again');
        }
        if (dryRun) {
            process.stdout.write(
                `Dry run: ${describe(bundle, options)} sequence ${options.sequence} passed every check; ` +
                `it would replace ${first ? `live sequence ${first.payload.sequence}` : 'a missing manifest'} on ${config.channel}. Nothing was written.\n`
            );
            return;
        }

        // 4. The only write that changes what users see.
        try {
            deps.r2Put(config, bundle.metadata.manifestObjectKey, candidate, 'application/json');
        } catch (error) {
            throw new Error(
                `the manifest write failed (${error.message}). The live manifest may or may not have changed: ` +
                `run verify (or read ${bundle.metadata.manifestObjectKey}) before doing anything else`
            );
        }

        // 5. Read it back from R2, then from the public edge.
        try {
            const written = readLiveFromR2(config, temporaryDirectory, 'after');
            if (!written || Buffer.compare(written.bytes, fs.readFileSync(candidate)) !== 0) {
                const found = written ? `live sequence ${written.payload.sequence}` : 'no manifest';
                throw new Error(`the live manifest is not the one written (${found}); another publication may have replaced it`);
            }
            await verifyPublicRelease(config, bundle, temporaryDirectory, { checkObjects: false });
        } catch (error) {
            throw new Error(
                `${error.message}. The manifest write was attempted and the release may already be live. ` +
                'Run verify. To revert, prepare a rollback or a withdrawal (a higher sequence); never lower the sequence.'
            );
        }
    } finally {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
    process.stdout.write(`Promoted ${describe(bundle, options)} sequence ${options.sequence} to ${config.channel}.\n`);
}

async function verify(config, options) {
    const bundle = readBundle(config, options);
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'microbot-cut-launcher-verify-'));
    try {
        await verifyPublicRelease(config, bundle, temporaryDirectory, { checkObjects: true });
    } finally {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
    process.stdout.write(
        `Verified ${config.channel} ${describe(bundle, options)} sequence ${options.sequence}: manifest, R2 objects and closed public prefix.\n` +
        'The authenticated download itself needs a signed-in session and is checked in the browser.\n'
    );
}

// While a dry run is active a write is a bug, not a setting.
function refuseWrites() {
    const original = deps.r2Put;
    deps.r2Put = (cfg, key) => {
        throw new Error(`a dry run attempted to write ${key}`);
    };
    return () => {
        deps.r2Put = original;
    };
}

async function main(argv = process.argv.slice(2)) {
    const { command, options } = parseArguments(argv);
    const config = loadConfiguration(options.config);
    if (command === 'prepare') return prepare(config, options);
    if (command === 'prepare-rollback') return prepareRollback(config, options);
    if (command === 'prepare-withdraw') return prepareWithdraw(config, options);
    if (command === 'verify') return verify(config, options);
    const run = command === 'stage' ? stage : promote;
    if (options['dry-run']) {
        const restore = refuseWrites();
        try {
            return await run(config, options);
        } finally {
            restore();
        }
    }
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
