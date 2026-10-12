const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
    PROFILE_FILE,
    PROFILE_NAMES,
    DistributionProfileError,
    loadProfileSource,
    serializeEmbeddedProfile,
    validateProfile
} = require('./distribution-profile');

// Build-time helpers for the one-installer-per-environment strategy (SITE-DOWNLOAD.md, L6).

function parseBuildArguments(argv) {
    const options = { profile: null, outputDirectory: null, allowDirty: false };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--profile') {
            options.profile = argv[++index];
        } else if (argument === '--output') {
            options.outputDirectory = argv[++index];
        } else if (argument === '--allow-dirty') {
            options.allowDirty = true;
        } else {
            throw new DistributionProfileError(`unknown build argument: ${argument}`);
        }
    }
    if (!PROFILE_NAMES.includes(options.profile)) {
        throw new DistributionProfileError(
            `a distribution profile is required: --profile ${PROFILE_NAMES.join('|')}`
        );
    }
    return options;
}

// electron-builder runs this before packing. It is the last line of defense: no installer, for
// any target or script, can be produced without a valid embedded profile.
async function requireDistributionProfile(context) {
    const projectDir = context?.packager?.projectDir || context?.appDir;
    if (!projectDir) throw new DistributionProfileError('cannot locate the project to check its distribution profile');
    const file = path.join(projectDir, PROFILE_FILE);
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        throw new DistributionProfileError(
            `${PROFILE_FILE} is missing or unreadable; build with "node scripts/build-distribution.js --profile <staging|production>" (${error.message})`
        );
    }
    validateProfile(raw, { requireSource: true });
}

// Writes the profile that electron-builder packs and returns how to remove it again. The file
// is gitignored and exists only for the duration of one build.
function embedProfile({ root, name, commit, version }) {
    const profile = loadProfileSource({ fs, path, root, name });
    const text = serializeEmbeddedProfile(profile, { commit, version });
    const file = path.join(root, PROFILE_FILE);
    if (fs.existsSync(file)) throw new Error(`${PROFILE_FILE} already exists; remove the leftover file first`);
    fs.writeFileSync(file, text, { encoding: 'utf8', flag: 'wx' });
    return { profile, text, cleanup: () => fs.rmSync(file, { force: true }) };
}

function normalizeAsarPath(entry) {
    return entry.replace(/\\/g, '/').replace(/^\/+/, '');
}

function packagesInAsar(entries) {
    const names = new Set();
    for (const entry of entries.map(normalizeAsarPath)) {
        const match = /^node_modules\/((?:@[^/]+\/)?[^/]+)\/package\.json$/.exec(entry);
        if (match) names.add(match[1]);
    }
    return names;
}

// Checks what actually ended up in the packed app, not what the build intended to pack.
function verifyPackedApp({ asarApi, asarPath, resourcesDirectory, expectedProfileText, dependencies }) {
    const entries = asarApi.listPackage(asarPath, { isPack: false }).map(normalizeAsarPath);
    // The macOS-only install instructions must not ship in the Windows package.
    const macOnly = entries.filter((entry) => /^build(\/|$)/i.test(entry) || /READ THIS BEFORE INSTALL/i.test(entry));
    if (macOnly.length) throw new Error(`the packed app contains macOS-only files: ${macOnly.join(', ')}`);
    if (!entries.includes(PROFILE_FILE)) throw new Error('the packed app has no embedded distribution profile');
    const embedded = asarApi.extractFile(asarPath, PROFILE_FILE).toString('utf8');
    if (embedded !== expectedProfileText) throw new Error('the embedded distribution profile differs from the one that was built');
    const config = asarApi.extractFile(asarPath, 'product-config.js').toString('utf8');
    if (!/updateFilesBase:\s*null/.test(config)) throw new Error('launcher auto-update is not disabled in the packed app');
    if (fs.existsSync(path.join(resourcesDirectory, 'app-update.yml'))) {
        throw new Error('the packed app contains an updater feed (app-update.yml)');
    }
    const packed = packagesInAsar(entries);
    const missing = dependencies.filter((name) => !packed.has(name));
    if (missing.length) throw new Error(`the packed app is missing dependencies: ${missing.join(', ')}`);
    return { packageCount: packed.size, embeddedProfileSha256: sha256(Buffer.from(embedded, 'utf8')) };
}

// electron-builder does not keep its effective configuration, so the identity is checked on the
// packed executable: its file name comes from productName and its version resource records the
// product name. The app id and shortcut name are pinned by the builder arguments below, which
// are unit tested, and are re-checked on the clean machine (L3).
function verifyInstallerIdentity({ identity, executableName, executableProductName }) {
    if (executableName !== `${identity.productName}.exe`) {
        throw new Error(`installed executable is ${executableName}, expected ${identity.productName}.exe`);
    }
    if (executableProductName !== identity.productName) {
        throw new Error(`executable product name is ${JSON.stringify(executableProductName)}, expected ${JSON.stringify(identity.productName)}`);
    }
    return { executableName, productName: executableProductName };
}

// electron-builder overrides that give each installer its own Windows identity.
function identityBuilderArguments(identity) {
    return [
        `--config.appId=${identity.appId}`,
        `--config.productName=${identity.productName}`,
        `--config.nsis.shortcutName=${identity.shortcutName}`,
        `--config.nsis.uninstallDisplayName=${identity.productName}`
    ];
}

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function effectiveChannelConfiguration(profile) {
    return {
        environment: profile.environment,
        installer: {
            appId: profile.identity.appId,
            productName: profile.identity.productName,
            shortcutName: profile.identity.shortcutName
        },
        dataDirectories: {
            productData: `~/${profile.identity.dataDirectoryName}`,
            legacyData: profile.identity.legacyDataDirectoryName ? `~/${profile.identity.legacyDataDirectoryName}` : null,
            electronUserData: profile.identity.userDataDirectoryName
                ? `%APPDATA%/${profile.identity.userDataDirectoryName}`
                : 'default (legacy Electron name)',
            clientHome: profile.identity.clientHomeDirectoryName
                ? `~/${profile.identity.dataDirectoryName}/${profile.identity.clientHomeDirectoryName}`
                : 'real user home'
        },
        apiBaseUrl: profile.api.baseUrl,
        releaseChannel: profile.release.channel,
        releaseManifestUrl: profile.release.manifestUrl,
        releaseArtifactBaseUrl: profile.release.artifactBaseUrl,
        releasePublicKeyId: profile.release.publicKeyId,
        pluginManifestUrl: profile.pluginRepository.manifestUrl,
        pluginReleasesUrl: profile.pluginRepository.releasesUrl,
        pluginPublicKeyId: profile.pluginRepository.publicKeyId,
        environmentVariableOverrides: false,
        launcherUpdateFeed: null
    };
}

module.exports = {
    effectiveChannelConfiguration,
    embedProfile,
    identityBuilderArguments,
    verifyInstallerIdentity,
    packagesInAsar,
    parseBuildArguments,
    requireDistributionProfile,
    sha256,
    verifyPackedApp
};
