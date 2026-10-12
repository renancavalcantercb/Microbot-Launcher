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

const { acquirePublicationLock, artifactUrl, downloadResponse, launcherRoot, loadConfiguration, run } = io;

function usage() {
    return [
        'Usage:',
        '  node scripts/publish-client-release.js prepare --version <version> --sequence <n> [--source-jar <path>] [--skip-build] [--allow-dirty]',
        '  node scripts/publish-client-release.js prepare-rollback --version <known-good-version> --source-sequence <n> --sequence <next-sequence>',
        '  node scripts/publish-client-release.js stage --version <version> --sequence <n> [--resume]',
        '  node scripts/publish-client-release.js promote --version <version> --sequence <n> --confirm-promote',
        '  node scripts/publish-client-release.js verify --version <version> --sequence <n>',
        '',
        'All commands default to config/release-publication.staging.json.',
        'Use --config config/release-publication.production.json for production.'
    ].join('\n');
}

function parseArguments(argv) {
    const [command, ...rest] = argv;
    if (!['prepare', 'prepare-rollback', 'stage', 'promote', 'verify'].includes(command)) {
        throw new Error(usage());
    }
    const options = {};
    for (let index = 0; index < rest.length; index += 1) {
        const token = rest[index];
        if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
        const name = token.slice(2);
        if (['skip-build', 'allow-dirty', 'resume', 'confirm-promote'].includes(name)) {
            options[name] = true;
            continue;
        }
        const value = rest[index + 1];
        if (!value || value.startsWith('--')) throw new Error(`missing value for ${token}`);
        options[name] = value;
        index += 1;
    }
    if (!options.version || !options.sequence) throw new Error(usage());
    options.sequence = Number(options.sequence);
    validateReleaseIdentity(options.version, options.sequence);
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

// Seam for tests: the commands reach the network, R2 and git only through these.
const deps = {
    workRoot: path.join(launcherRoot, '.release-work'),
    liveManifest: io.liveManifest,
    fetchResponse: io.fetchResponse,
    r2Get: io.r2Get,
    r2Put: io.r2Put,
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
    return {
        directory,
        ...readAndVerifyBundle({
            outputDirectory: directory,
            channel: config.channel,
            keyId: config.keyId,
            publicKey: config.publicKey
        })
    };
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

async function prepare(config, options) {
    const sourceDirty = deps.gitDirty(config.clientRepository);
    if (sourceDirty && !options['allow-dirty']) {
        throw new Error('client repository has uncommitted changes; commit them or use --allow-dirty for a local-only bundle');
    }
    // A client release must not unpublish the launcher: the live entry is carried over unchanged.
    const live = await deps.liveManifest(config, { allowMissing: true });
    if (!options['skip-build']) deps.runGradleBuild(config);
    const sourceJar = path.resolve(launcherRoot, options['source-jar'] || config.sourceJar);
    const outputDirectory = bundleDirectory(
        deps.workRoot,
        config.channel,
        options.version,
        options.sequence
    );
    const result = prepareClientRelease({
        sourceJar,
        outputDirectory,
        channel: config.channel,
        version: options.version,
        sequence: options.sequence,
        minimumLauncherVersion: config.minimumLauncherVersion,
        keyId: config.keyId,
        privateKeyPem: fs.readFileSync(config.privateKeyPath, 'utf8'),
        publicKey: config.publicKey,
        sourceCommit: deps.gitCommit(config.clientRepository),
        sourceDirty,
        launcher: live?.launcher ?? null
    });
    process.stdout.write(
        `Prepared ${options.version} sequence ${options.sequence}\n` +
        `Size: ${result.payload.client.size} bytes\n` +
        `SHA-256: ${result.payload.client.sha256}\n` +
        `Bundle: ${outputDirectory}\n`
    );
}

async function prepareRollback(config, options) {
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
        options.sequence
    );
    const live = await deps.liveManifest(config, { allowMissing: true });
    const result = prepareClientRollback({
        sourceDirectory,
        outputDirectory,
        channel: config.channel,
        sequence: options.sequence,
        keyId: config.keyId,
        privateKeyPem: fs.readFileSync(config.privateKeyPath, 'utf8'),
        publicKey: config.publicKey,
        launcher: live?.launcher ?? null
    });
    process.stdout.write(
        `Prepared rollback to ${options.version} at sequence ${options.sequence}\n` +
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
    const current = await deps.liveManifest(config, { allowMissing: true });
    requireNewerSequence(bundle.payload, current);
    requireClientReleaseKeepsLauncher(bundle.payload, current);
    const publicUrl = artifactUrl(config, bundle.payload.client.artifactPath);
    const head = await deps.fetchResponse(publicUrl, { method: 'HEAD', cache: 'no-store' });
    if (![200, 404].includes(head.status)) {
        throw new Error(`artifact preflight returned unexpected HTTP ${head.status}`);
    }
    if (bundle.metadata.reusesArtifact && head.status === 404) {
        throw new Error('known-good rollback artifact is no longer available');
    }
    if (head.status !== 404 && !bundle.metadata.reusesArtifact && !options.resume) {
        throw new Error(`immutable artifact already exists (HTTP ${head.status}); use --resume only to verify it`);
    }

    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'microbot-cut-release-'));
    try {
        const artifactReadback = path.join(temporaryDirectory, bundle.metadata.artifactFile);
        if (head.status === 404) {
            deps.r2Put(config, bundle.metadata.artifactObjectKey, bundle.artifactFile, 'application/java-archive');
        }
        const artifactResponse = await deps.fetchResponse(publicUrl, { cache: 'no-store' });
        if (!artifactResponse.ok) throw new Error(`artifact read-back returned HTTP ${artifactResponse.status}`);
        await downloadResponse(artifactResponse, artifactReadback);
        if (
            fs.statSync(artifactReadback).size !== bundle.payload.client.size ||
            sha256File(artifactReadback) !== bundle.payload.client.sha256
        ) {
            throw new Error('R2 artifact read-back failed size or SHA-256 verification');
        }

        const candidateReadback = path.join(temporaryDirectory, 'candidate.json');
        const candidateExists = deps.r2Get(
            config,
            bundle.metadata.candidateObjectKey,
            candidateReadback,
            { allowMissing: true }
        );
        if (candidateExists && !options.resume) {
            throw new Error('immutable candidate manifest already exists; use --resume only to verify it');
        }
        if (!candidateExists) {
            deps.r2Put(config, bundle.metadata.candidateObjectKey, path.join(bundle.directory, 'manifest.json'), 'application/json');
            deps.r2Get(config, bundle.metadata.candidateObjectKey, candidateReadback);
        }
        const candidateEnvelope = JSON.parse(fs.readFileSync(candidateReadback, 'utf8'));
        const candidatePayload = verifyReleaseManifest(candidateEnvelope, {
            expectedChannel: config.channel,
            trustedKeys: { [config.keyId]: config.publicKey }
        });
        if (
            candidatePayload.sequence !== bundle.payload.sequence ||
            candidatePayload.client.sha256 !== bundle.payload.client.sha256 ||
            JSON.stringify(candidateEnvelope) !== JSON.stringify(bundle.envelope)
        ) {
            throw new Error('R2 candidate does not match the local release bundle');
        }
    } finally {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
    process.stdout.write(`Staged immutable ${options.version} sequence ${options.sequence}; the live channel was not changed.\n`);
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
    if (!options['confirm-promote']) {
        throw new Error('promotion requires --confirm-promote');
    }
    const bundle = releaseBundle(config, options);
    const current = await deps.liveManifest(config, { allowMissing: true });
    requireNewerSequence(bundle.payload, current);
    requireClientReleaseKeepsLauncher(bundle.payload, current);
    const artifactHead = await deps.fetchResponse(
        artifactUrl(config, bundle.payload.client.artifactPath),
        { method: 'HEAD', cache: 'no-store' }
    );
    if (
        !artifactHead.ok ||
        Number(artifactHead.headers.get('content-length')) !== bundle.payload.client.size
    ) {
        throw new Error('staged artifact is unavailable or has the wrong size');
    }
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'microbot-cut-promote-'));
    try {
        const candidate = path.join(temporaryDirectory, 'candidate.json');
        if (!deps.r2Get(config, bundle.metadata.candidateObjectKey, candidate, { allowMissing: true })) {
            throw new Error('candidate manifest is not staged');
        }
        const candidateEnvelope = JSON.parse(fs.readFileSync(candidate, 'utf8'));
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
        deps.r2Put(config, bundle.metadata.manifestObjectKey, candidate, 'application/json');
    } finally {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
    await verifyPublicRelease(config, bundle);
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
    const release = acquirePublicationLock(deps.workRoot, config.channel, `client ${command} ${options.version}`);
    try {
        return await (command === 'stage' ? stage(config, options) : promote(config, options));
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
