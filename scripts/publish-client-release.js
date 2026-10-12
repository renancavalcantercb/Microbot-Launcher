const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    bundleDirectory,
    prepareClientRollback,
    prepareClientRelease,
    readAndVerifyBundle,
    requireNewerSequence,
    sha256File,
    validateReleaseIdentity
} = require('../libs/client-release-publication');
const { verifyReleaseManifest } = require('../libs/release-manifest');
const { requireClientReleaseKeepsLauncher } = require('../libs/launcher-release-publication');
const io = require('../libs/release-publication-io');
const ops = require('../libs/release-store-ops');
const { openStore } = require('../libs/r2-store');

const { acquirePublicationLock, artifactUrl, downloadResponse, launcherRoot, loadConfiguration, run } = io;

function usage() {
    return [
        'The sequence of a new release is computed from the live manifest in R2 (live + 1); it is never typed.',
        'prepare prints it, and stage, promote and verify take it back with --sequence to find the bundle.',
        'Usage:',
        '  node scripts/publish-client-release.js prepare --version <version> [--source-jar <path>] [--skip-build] [--allow-dirty]',
        '  node scripts/publish-client-release.js prepare-rollback --version <known-good-version> --source-sequence <n>',
        '  node scripts/publish-client-release.js stage --version <version> --sequence <n> [--resume] [--dry-run]',
        '  node scripts/publish-client-release.js promote --version <version> --sequence <n> --confirm-promote [--dry-run]',
        '  node scripts/publish-client-release.js verify --version <version> --sequence <n>',
        '',
        'All commands default to config/release-publication.staging.json.',
        'Use --config config/release-publication.production.json for production.'
    ].join('\n');
}

const COMMAND_OPTIONS = {
    prepare: ['version', 'source-jar', 'skip-build', 'allow-dirty', 'config'],
    'prepare-rollback': ['version', 'source-sequence', 'config'],
    stage: ['version', 'sequence', 'resume', 'dry-run', 'config'],
    promote: ['version', 'sequence', 'confirm-promote', 'dry-run', 'config'],
    verify: ['version', 'sequence', 'config']
};
const FLAGS = ['skip-build', 'allow-dirty', 'resume', 'confirm-promote', 'dry-run'];

function parseArguments(argv) {
    const [command, ...rest] = argv;
    if (!Object.prototype.hasOwnProperty.call(COMMAND_OPTIONS, command)) {
        throw new Error(usage());
    }
    const options = {};
    for (let index = 0; index < rest.length; index += 1) {
        const token = rest[index];
        if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
        const name = token.slice(2);
        if (name === 'sequence' && !COMMAND_OPTIONS[command].includes(name)) {
            throw new Error(`${command} computes the sequence from the live manifest; --sequence is not accepted`);
        }
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
    if (!options.version) throw new Error(usage());
    if (['stage', 'promote', 'verify'].includes(command)) {
        if (!options.sequence) throw new Error(usage());
        options.sequence = Number(options.sequence);
        validateReleaseIdentity(options.version, options.sequence);
    } else {
        validateReleaseIdentity(options.version, 1);
    }
    if (command === 'prepare-rollback') {
        options['source-sequence'] = Number(options['source-sequence']);
        if (!Number.isSafeInteger(options['source-sequence']) || options['source-sequence'] <= 0) {
            throw new Error('prepare-rollback requires a positive --source-sequence');
        }
    }
    return { command, options };
}

function runGradleBuild(config) {
    const executable = process.platform === 'win32'
        ? path.join(config.clientRepository, 'gradlew.bat')
        : path.join(config.clientRepository, 'gradlew');
    process.stdout.write('Building the shaded client JAR...\n');
    const environment = {
        GRADLE_USER_HOME: config.gradleUserHome,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'safe.directory',
        GIT_CONFIG_VALUE_0: config.clientRepository.replace(/\\/g, '/')
    };
    if (process.platform === 'win32') {
        run(
            process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
            ['/d', '/s', '/c', 'call gradlew.bat :client:assemble'],
            config.clientRepository,
            { env: environment }
        );
        return;
    }
    run(executable, [':client:assemble'], config.clientRepository, { env: environment });
}

// Seam for tests: the commands reach the network, R2 and git only through these. `openStore` builds
// the S3 transport; a store opened with `writable: false` cannot write, and prepare, verify and
// every dry run open it that way.
const deps = {
    workRoot: path.join(launcherRoot, '.release-work'),
    liveManifest: io.liveManifest,
    fetchResponse: io.fetchResponse,
    openStore,
    runGradleBuild,
    gitCommit,
    gitDirty
};

function releaseBundle(config, options) {
    const directory = bundleDirectory(
        deps.workRoot,
        config.channel,
        options.version,
        options.sequence
    );
    const bundle = readAndVerifyBundle({
        outputDirectory: directory,
        channel: config.channel,
        keyId: config.keyId,
        publicKey: config.publicKey
    });
    return { directory, base: ops.requireBase(bundle.metadata), ...bundle };
}

function gitCommit(repository) {
    return run('git', ['-c', `safe.directory=${repository.replace(/\\/g, '/')}`, 'rev-parse', 'HEAD'], repository);
}

function gitDirty(repository) {
    return run(
        'git',
        ['-c', `safe.directory=${repository.replace(/\\/g, '/')}`, 'status', '--porcelain'],
        repository
    ).length > 0;
}

function recordBaseOrDiscard(directory, live) {
    try {
        ops.recordBase(directory, live);
    } catch (error) {
        fs.rmSync(directory, { recursive: true, force: true });
        throw error;
    }
}

const baseLine = (live, sequence) =>
    `Sequence: ${sequence} (${live ? `live sequence ${live.payload.sequence} + 1` : 'no live manifest yet'})\n` +
    `Based on live ETag: ${live ? live.etag : 'none (the manifest does not exist yet)'}\n`;

async function prepare(config, options) {
    const sourceDirty = deps.gitDirty(config.clientRepository);
    if (sourceDirty && !options['allow-dirty']) {
        throw new Error('client repository has uncommitted changes; commit them or use --allow-dirty for a local-only bundle');
    }
    if (!options['skip-build']) deps.runGradleBuild(config);
    // The live manifest is read after the build, which can take minutes, so the base is current. A
    // client release must not unpublish the launcher: the live entry is carried over unchanged.
    const live = await ops.readLiveManifest(deps.openStore(config, { writable: false }), config);
    const sequence = ops.nextSequence(live);
    const sourceJar = path.resolve(launcherRoot, options['source-jar'] || config.sourceJar);
    const outputDirectory = bundleDirectory(
        deps.workRoot,
        config.channel,
        options.version,
        sequence
    );
    const result = prepareClientRelease({
        sourceJar,
        outputDirectory,
        channel: config.channel,
        version: options.version,
        sequence,
        minimumLauncherVersion: config.minimumLauncherVersion,
        keyId: config.keyId,
        privateKeyPem: fs.readFileSync(config.privateKeyPath, 'utf8'),
        publicKey: config.publicKey,
        sourceCommit: deps.gitCommit(config.clientRepository),
        sourceDirty,
        launcher: live?.payload.launcher ?? null
    });
    recordBaseOrDiscard(outputDirectory, live);
    process.stdout.write(
        `Prepared ${options.version}\n` +
        baseLine(live, sequence) +
        `Size: ${result.payload.client.size} bytes\n` +
        `SHA-256: ${result.payload.client.sha256}\n` +
        `Bundle: ${outputDirectory}\n`
    );
}

async function prepareRollback(config, options) {
    const live = await ops.readLiveManifest(deps.openStore(config, { writable: false }), config);
    const sequence = ops.nextSequence(live);
    const sourceDirectory = bundleDirectory(
        deps.workRoot,
        config.channel,
        options.version,
        options['source-sequence']
    );
    const outputDirectory = bundleDirectory(
        deps.workRoot,
        config.channel,
        options.version,
        sequence
    );
    const result = prepareClientRollback({
        sourceDirectory,
        outputDirectory,
        channel: config.channel,
        sequence,
        keyId: config.keyId,
        privateKeyPem: fs.readFileSync(config.privateKeyPath, 'utf8'),
        publicKey: config.publicKey,
        launcher: live?.payload.launcher ?? null
    });
    recordBaseOrDiscard(outputDirectory, live);
    process.stdout.write(
        `Prepared rollback to ${options.version}\n` +
        baseLine(live, sequence) +
        `Reused sequence: ${result.source.payload.sequence}\n` +
        `SHA-256: ${result.payload.client.sha256}\n` +
        `Bundle: ${outputDirectory}\n`
    );
}

async function stage(config, options) {
    const bundle = releaseBundle(config, options);
    if (bundle.metadata.sourceDirty) {
        throw new Error('refusing to stage a release prepared from an uncommitted client worktree');
    }
    const dryRun = Boolean(options['dry-run']);
    const store = deps.openStore(config, { writable: !dryRun });
    const live = await ops.readLiveManifest(store, config);
    ops.requireLiveMatchesBase(live, bundle.base);
    requireNewerSequence(bundle.payload, live && live.payload);
    requireClientReleaseKeepsLauncher(bundle.payload, live && live.payload);

    const report = [];
    const objects = [
        {
            name: 'artifact',
            key: bundle.metadata.artifactObjectKey,
            file: bundle.artifactFile,
            contentType: 'application/java-archive',
            reuse: Boolean(bundle.metadata.reusesArtifact)
        },
        {
            name: 'candidate',
            key: bundle.metadata.candidateObjectKey,
            file: path.join(bundle.directory, 'manifest.json'),
            contentType: 'application/json',
            reuse: false
        }
    ];
    for (const spec of objects) {
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
        if (spec.name === 'artifact' && !dryRun) await verifyPublicArtifact(config, bundle);
    }
    process.stdout.write(`${report.join('\n')}\n`);
    process.stdout.write(dryRun
        ? 'Dry run: nothing was written to R2.\n'
        : `Staged immutable ${options.version} sequence ${options.sequence}; the live channel was not changed.\n`);
}

// What the public edge serves for the artifact must be the bundle's bytes.
async function verifyPublicArtifact(config, bundle) {
    const publicUrl = artifactUrl(config, bundle.payload.client.artifactPath);
    const response = await deps.fetchResponse(publicUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error(`artifact read-back returned HTTP ${response.status}`);
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'microbot-cut-release-'));
    try {
        const destination = path.join(temporaryDirectory, bundle.metadata.artifactFile);
        await downloadResponse(response, destination);
        if (
            fs.statSync(destination).size !== bundle.payload.client.size ||
            sha256File(destination) !== bundle.payload.client.sha256
        ) {
            throw new Error('public artifact read-back failed size or SHA-256 verification');
        }
    } finally {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
}

async function verifyPublicRelease(config, bundle) {
    const current = await deps.liveManifest(config);
    if (
        current.sequence !== bundle.payload.sequence ||
        current.client.sha256 !== bundle.payload.client.sha256
    ) {
        throw new Error('public manifest does not match the selected release bundle');
    }
    const publicUrl = artifactUrl(config, bundle.payload.client.artifactPath);
    const head = await deps.fetchResponse(publicUrl, { method: 'HEAD', cache: 'no-store' });
    if (!head.ok || Number(head.headers.get('content-length')) !== bundle.payload.client.size) {
        throw new Error('public artifact HEAD validation failed');
    }
    const range = await deps.fetchResponse(publicUrl, {
        headers: { Range: 'bytes=0-0' },
        cache: 'no-store'
    });
    if (
        range.status !== 206 ||
        range.headers.get('content-range') !== `bytes 0-0/${bundle.payload.client.size}` ||
        (await range.arrayBuffer()).byteLength !== 1
    ) {
        throw new Error('public artifact Range validation failed');
    }
    return current;
}

async function promote(config, options) {
    const dryRun = Boolean(options['dry-run']);
    if (!dryRun && !options['confirm-promote']) {
        throw new Error('promotion requires --confirm-promote');
    }
    const bundle = releaseBundle(config, options);
    const store = deps.openStore(config, { writable: !dryRun });
    const live = await ops.readLiveManifest(store, config);
    ops.requireLiveMatchesBase(live, bundle.base);
    requireNewerSequence(bundle.payload, live && live.payload);
    requireClientReleaseKeepsLauncher(bundle.payload, live && live.payload);
    const artifact = await store.head(bundle.metadata.artifactObjectKey);
    if (!artifact.found || artifact.size !== bundle.payload.client.size) {
        throw new Error('staged artifact is unavailable or has the wrong size');
    }
    const staged = await store.get(bundle.metadata.candidateObjectKey);
    if (!staged.found) throw new Error('candidate manifest is not staged');
    const candidateEnvelope = JSON.parse(staged.bytes.toString('utf8'));
    const candidatePayload = verifyReleaseManifest(candidateEnvelope, {
        expectedChannel: config.channel,
        trustedKeys: { [config.keyId]: config.publicKey }
    });
    if (
        candidatePayload.sequence !== bundle.payload.sequence ||
        candidatePayload.client.sha256 !== bundle.payload.client.sha256 ||
        JSON.stringify(candidateEnvelope) !== JSON.stringify(bundle.envelope)
    ) {
        throw new Error('staged candidate does not match the local release bundle');
    }
    if (dryRun) {
        process.stdout.write(
            `Dry run: ${options.version} sequence ${options.sequence} passed every check; ` +
            `it would replace ${live ? `live sequence ${live.payload.sequence}` : 'a missing manifest'} on ${config.channel}, ` +
            `written only if the live ETag is still ${bundle.base.etag}. Nothing was written.\n`
        );
        return;
    }

    // The only write that changes what users see. It carries If-Match with the ETag of the manifest
    // this bundle was prepared against, so R2 refuses it if anything else (a launcher release, another
    // client release) was published since. A conflict is not retried and nothing is overwritten.
    try {
        await ops.promoteManifest(store, config, { bytes: staged.bytes, base: bundle.base });
    } catch (error) {
        if (error instanceof ops.PublicationConflictError || error instanceof ops.WriteNotAppliedError) throw error;
        throw new Error(
            `${error.message}. The manifest write was attempted and the release may already be live. ` +
            'Run verify. To revert, prepare a rollback (a higher sequence); never lower the sequence.'
        );
    }
    try {
        await verifyPublicRelease(config, bundle);
    } catch (error) {
        throw new Error(
            `${error.message}. The manifest was written and the release is live in R2. ` +
            'Run verify (the public edge caches the manifest for up to a minute).'
        );
    }
    process.stdout.write(`Promoted ${options.version} sequence ${options.sequence} to ${config.channel}.\n`);
}

async function verify(config, options) {
    const bundle = releaseBundle(config, options);
    await verifyPublicRelease(config, bundle);
    process.stdout.write(`Verified public ${config.channel} release ${options.version} sequence ${options.sequence}.\n`);
}

async function main(argv = process.argv.slice(2)) {
    const { command, options } = parseArguments(argv);
    const config = loadConfiguration(options.config);
    if (command === 'prepare') return prepare(config, options);
    if (command === 'prepare-rollback') return prepareRollback(config, options);
    if (command === 'verify') return verify(config, options);
    const run = command === 'stage' ? stage : promote;
    // A dry run writes nothing and so needs no lock; its store is opened read-only.
    if (options['dry-run']) return run(config, options);
    // The lock keeps two publications of this machine apart. Across machines the ETag condition on
    // every write is what protects the channel.
    const release = acquirePublicationLock(deps.workRoot, config.channel, `client ${command} ${options.version}`);
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

module.exports = { deps, loadConfiguration, main, parseArguments, prepare, prepareRollback, promote, stage };
