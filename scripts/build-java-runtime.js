#!/usr/bin/env node
/* Builds the embedded Java runtime (B-3.1): downloads or takes the official Eclipse Temurin 17
 * archive, verifies it against the pin, the publisher's checksum and the publisher's signature,
 * reduces it with jlink, and writes runtime-manifest.json. It fails closed on any mismatch and
 * never uses a JDK found on the machine. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const AdmZip = require('adm-zip');
const { buildRuntimeManifest, serializeManifest, verifyEmbeddedRuntime, MANIFEST_FILE } = require('../libs/embedded-runtime');
const {
    PIN_FILE,
    RuntimeBuildError,
    jlinkArguments,
    validatePin,
    verifyArchive,
    verifySignature
} = require('../libs/java-runtime-build');

const root = path.resolve(__dirname, '..');
const DEFAULT_OUTPUT = path.join(root, '.release-work', 'java-runtime', 'image');

function parseArguments(argv) {
    const options = { work: null, output: DEFAULT_OUTPUT, archive: null, signature: null, checksum: null, gpg: 'gpg', gpgv: 'gpgv', writePin: false, force: false };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        const next = () => argv[++index];
        if (argument === '--work') options.work = next();
        else if (argument === '--output') options.output = path.resolve(next());
        else if (argument === '--archive') options.archive = path.resolve(next());
        else if (argument === '--signature') options.signature = path.resolve(next());
        else if (argument === '--checksum') options.checksum = path.resolve(next());
        else if (argument === '--gpg') options.gpg = next();
        else if (argument === '--gpgv') options.gpgv = next();
        else if (argument === '--write-pin') options.writePin = true;
        else if (argument === '--force') options.force = true;
        else throw new RuntimeBuildError(`unknown argument: ${argument}`);
    }
    return options;
}

async function download(url, destination) {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) throw new RuntimeBuildError(`download failed (${response.status}): ${url}`);
    fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
}

function extractSafely(archivePath, destination) {
    const zip = new AdmZip(archivePath);
    for (const entry of zip.getEntries()) {
        const target = path.resolve(destination, entry.entryName);
        if (target !== path.resolve(destination) && !target.startsWith(path.resolve(destination) + path.sep)) {
            throw new RuntimeBuildError(`the archive contains a path outside its folder: ${entry.entryName}`);
        }
    }
    zip.extractAllTo(destination, true);
}

function run(command, args, label) {
    const result = childProcess.spawnSync(command, args, { encoding: 'utf8' });
    if (result.error || result.status !== 0) {
        throw new RuntimeBuildError(`${label} failed: ${result.error?.message || result.stderr || result.stdout}`);
    }
    return result.stdout + result.stderr;
}

async function main() {
    const options = parseArguments(process.argv.slice(2));
    const pinPath = path.join(root, PIN_FILE);
    const pin = validatePin(JSON.parse(fs.readFileSync(pinPath, 'utf8')));
    const work = path.resolve(options.work || path.join(os.tmpdir(), `microbot-cut-java-runtime-${process.pid}`));
    if (work === root || work.startsWith(root + path.sep)) {
        throw new RuntimeBuildError('the work directory must be outside the repository');
    }
    fs.mkdirSync(work, { recursive: true });

    const archivePath = options.archive || path.join(work, pin.archive.name);
    const signaturePath = options.signature || `${archivePath}.sig`;
    const checksumPath = options.checksum || `${archivePath}.sha256.txt`;
    if (!options.archive) await download(pin.archive.url, archivePath);
    if (!options.signature) await download(pin.archive.signatureUrl, signaturePath);
    if (!options.checksum) await download(pin.archive.checksumUrl, checksumPath);

    const archiveSha256 = verifyArchive({
        fs,
        archivePath,
        pin,
        checksumText: fs.readFileSync(checksumPath, 'utf8')
    });
    console.log(`archive sha256 ok: ${archiveSha256}`);
    const signature = verifySignature({
        fs,
        path,
        os,
        gpg: options.gpg,
        gpgv: options.gpgv,
        archivePath,
        signaturePath,
        publicKeyPath: path.join(root, pin.signing.publicKeyFile),
        fingerprint: pin.signing.keyFingerprint
    });
    console.log(`signature ok, signing key ${signature.signer}`);

    const extractDir = path.join(work, 'extract');
    fs.rmSync(extractDir, { recursive: true, force: true });
    extractSafely(archivePath, extractDir);
    const roots = fs.readdirSync(extractDir);
    if (roots.length !== 1) throw new RuntimeBuildError('the archive does not hold exactly one JDK folder');
    const jdk = path.join(extractDir, roots[0]);
    const release = fs.readFileSync(path.join(jdk, 'release'), 'utf8');
    if (!release.includes(`IMPLEMENTOR_VERSION="Temurin-${pin.fullVersion}"`)) {
        throw new RuntimeBuildError(`the archive is not Temurin ${pin.fullVersion}`);
    }
    if (!release.includes(pin.sources.jdk17u.slice(0, 12))) {
        throw new RuntimeBuildError('the archive was built from a different jdk17u commit than the pin');
    }

    const imageDir = path.join(work, 'image');
    fs.rmSync(imageDir, { recursive: true, force: true });
    const jlink = path.join(jdk, 'bin', process.platform === 'win32' ? 'jlink.exe' : 'jlink');
    run(jlink, jlinkArguments({ pin, jmodsDir: path.join(jdk, 'jmods'), outputDir: imageDir }), 'jlink');

    const notice = path.join(jdk, 'NOTICE');
    if (!fs.existsSync(notice) || !fs.existsSync(path.join(imageDir, 'legal'))) {
        throw new RuntimeBuildError('the license notices (NOTICE and legal/) are missing');
    }
    fs.copyFileSync(notice, path.join(imageDir, 'NOTICE'));

    const javaBinary = path.join(imageDir, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    const modules = run(javaBinary, ['--list-modules'], 'the image smoke test')
        .split(/\r?\n/)
        .map((line) => line.trim().split('@')[0])
        .filter(Boolean)
        .sort();
    const missing = pin.jlink.modules.filter((name) => !modules.includes(name));
    if (missing.length) throw new RuntimeBuildError(`the image lacks modules: ${missing.join(', ')}`);
    const settings = run(javaBinary, ['-XshowSettings:properties', '-version'], 'the version probe');
    if (!settings.includes(`java.version = ${pin.javaVersion}`)) {
        throw new RuntimeBuildError('the image does not report the pinned Java version');
    }

    const manifest = buildRuntimeManifest({
        fs,
        path,
        imageDir,
        description: {
            supplier: pin.supplier,
            javaVersion: pin.javaVersion,
            fullVersion: pin.fullVersion,
            archive: { name: pin.archive.name, sha256: archiveSha256 },
            signingKeyFingerprint: pin.signing.keyFingerprint,
            sources: pin.sources,
            jlinkOptions: pin.jlink.options,
            modules
        }
    });
    fs.writeFileSync(path.join(imageDir, MANIFEST_FILE), serializeManifest(manifest), 'utf8');
    verifyEmbeddedRuntime({ fs, path, runtimeDir: imageDir, expected: { javaVersion: pin.javaVersion, imageSha256: manifest.imageSha256 } });

    if (pin.image.sha256 && pin.image.sha256 !== manifest.imageSha256) {
        throw new RuntimeBuildError(`the image digest ${manifest.imageSha256} differs from the pinned ${pin.image.sha256}`);
    }
    if (!pin.image.sha256 && !options.writePin) {
        console.log('note: the pin has no image digest yet; run again with --write-pin to record it');
    }

    if (fs.existsSync(options.output)) {
        if (!fs.existsSync(path.join(options.output, MANIFEST_FILE)) && !options.force) {
            throw new RuntimeBuildError(`${options.output} exists and is not a runtime image; refusing to replace it`);
        }
        fs.rmSync(options.output, { recursive: true, force: true });
    }
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.cpSync(imageDir, options.output, { recursive: true });
    verifyEmbeddedRuntime({ fs, path, runtimeDir: options.output, expected: { javaVersion: pin.javaVersion, imageSha256: manifest.imageSha256 } });

    if (options.writePin && pin.image.sha256 !== manifest.imageSha256) {
        pin.image.sha256 = manifest.imageSha256;
        fs.writeFileSync(pinPath, `${JSON.stringify(pin, null, 2)}\n`, 'utf8');
        console.log('pin updated with the image digest');
    }
    const bytes = manifest.files.reduce((sum, file) => sum + file.size, 0);
    console.log(`image ${options.output}`);
    console.log(`files ${manifest.files.length}, ${(bytes / 1048576).toFixed(1)} MB, modules ${modules.length}`);
    console.log(`imageSha256 ${manifest.imageSha256}`);
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.rmSync(imageDir, { recursive: true, force: true });
}

main().catch((error) => {
    console.error(`build-java-runtime: ${error.message}`);
    process.exit(1);
});
