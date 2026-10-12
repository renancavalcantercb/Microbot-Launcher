const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
    effectiveChannelConfiguration,
    embedProfile,
    identityBuilderArguments,
    parseBuildArguments,
    verifyInstallerIdentity,
    verifyPackedApp
} = require('../libs/distribution-build');
const {
    buildUpdaterMetadata,
    describeInstaller,
    installerFileName,
    verifyUpdaterMetadata
} = require('../libs/launcher-release-publication');

// Builds the unsigned Windows installer for ONE environment:
//   node scripts/build-distribution.js --profile staging|production [--output <dir>] [--allow-dirty]
// There is no default profile. The profile is embedded in the app (distribution-profile.json),
// verified inside the packed app.asar, and recorded in candidate.json next to the installer.

const root = path.join(__dirname, '..');

function git(...args) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
}

function run(command, args) {
    const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${path.basename(command)} exited with ${result.status}`);
}

function main() {
    const options = parseBuildArguments(process.argv.slice(2));
    if (process.platform !== 'win32') throw new Error('The Windows installer must be built on Windows.');

    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const version = packageJson.version;
    const commit = git('rev-parse', 'HEAD');
    const dirty = git('status', '--porcelain', '--untracked-files=no') !== '';
    if (dirty && !options.allowDirty) {
        throw new Error('The working tree has uncommitted changes. Commit them or build from a clean checkout.');
    }

    const outputDirectory = path.resolve(
        options.outputDirectory ||
        path.join(root, '.release-work', 'candidates', version, options.profile)
    );
    if (fs.existsSync(outputDirectory)) throw new Error(`output already exists: ${outputDirectory}`);
    const buildDirectory = path.join(outputDirectory, 'build');

    const embedded = embedProfile({ root, name: options.profile, commit, version });
    const { profile, text: profileText } = embedded;
    fs.mkdirSync(outputDirectory, { recursive: true });
    try {
        const cli = require.resolve('electron-builder/cli.js');
        run(process.execPath, [
            cli, '--win', 'nsis', '--publish', 'never',
            `--config.directories.output=${buildDirectory}`,
            ...identityBuilderArguments(profile.identity)
        ]);
    } finally {
        embedded.cleanup();
    }

    const resources = path.join(buildDirectory, 'win-unpacked', 'resources');
    const asarPath = path.join(resources, 'app.asar');
    const packed = verifyPackedApp({
        asarApi: require('@electron/asar'),
        asarPath,
        resourcesDirectory: resources,
        expectedProfileText: profileText,
        dependencies: Object.keys(packageJson.dependencies || {})
    });

    const unpacked = path.join(buildDirectory, 'win-unpacked');
    const executables = fs.readdirSync(unpacked).filter((name) => name.toLowerCase().endsWith('.exe'));
    const executable = executables.length === 1 ? executables[0] : executables.join(',');
    const versionInfo = spawnSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        '(Get-Item -LiteralPath $args[0]).VersionInfo.ProductName',
        path.join(unpacked, executable)
    ], { encoding: 'utf8' });
    verifyInstallerIdentity({
        identity: profile.identity,
        executableName: executable,
        executableProductName: (versionInfo.stdout || '').trim()
    });

    const fileName = installerFileName(version);
    const builtInstaller = path.join(buildDirectory, fileName);
    const installerPath = path.join(outputDirectory, fileName);
    fs.copyFileSync(builtInstaller, installerPath, fs.constants.COPYFILE_EXCL);
    const described = describeInstaller(installerPath);
    const builtAt = new Date().toISOString();
    const metadataText = buildUpdaterMetadata({
        version, fileName, size: described.size, sha512Base64: described.sha512Base64, releaseDate: builtAt
    });
    fs.writeFileSync(path.join(outputDirectory, 'latest.yml'), metadataText, { encoding: 'utf8', flag: 'wx' });
    verifyUpdaterMetadata({ metadataText, installerPath, version });
    fs.writeFileSync(
        path.join(outputDirectory, 'SHA256SUMS.txt'),
        `${described.sha256}  ${fileName}\n`,
        { encoding: 'utf8', flag: 'wx' }
    );

    const asarSha256 = require('crypto').createHash('sha256').update(fs.readFileSync(asarPath)).digest('hex');
    const candidate = {
        kind: 'launcher-candidate',
        unsigned: true,
        profile: options.profile,
        version,
        file: fileName,
        size: described.size,
        sha256: described.sha256,
        sha512Base64: described.sha512Base64,
        sourceCommit: commit,
        sourceDirty: dirty,
        effectiveConfiguration: effectiveChannelConfiguration(profile),
        embeddedProfileSha256: packed.embeddedProfileSha256,
        appAsarSha256: asarSha256,
        packedPackages: packed.packageCount,
        tools: {
            electron: require('electron/package.json').version,
            electronBuilder: require('electron-builder/package.json').version,
            node: process.version,
            os: `${os.type()} ${os.release()}`
        },
        builtAt
    };
    fs.writeFileSync(
        path.join(outputDirectory, 'candidate.json'),
        `${JSON.stringify(candidate, null, 2)}\n`,
        { encoding: 'utf8', flag: 'wx' }
    );
    // The unpacked app and builder intermediates are large and not part of the candidate.
    fs.rmSync(buildDirectory, { recursive: true, force: true });
    console.log(JSON.stringify({ outputDirectory, profile: options.profile, sha256: described.sha256, size: described.size }, null, 2));
}

try {
    main();
} catch (error) {
    console.error(`build-distribution failed: ${error.message}`);
    process.exit(1);
}
