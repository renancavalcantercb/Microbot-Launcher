const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const { verifyReleaseManifest } = require('./release-manifest');

// What the publication CLIs share besides R2 (see r2-store.js and release-store-ops.js): the
// configuration, the edge, git and the per-machine lock. Each CLI reaches all of it through its
// `deps` object, so the commands can be tested with fixtures and never need the network.

const launcherRoot = path.resolve(__dirname, '..');

function loadConfiguration(configArgument) {
    const configPath = path.resolve(
        launcherRoot,
        configArgument || 'config/release-publication.staging.json'
    );
    const configDirectory = path.dirname(configPath);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const publicMetadata = JSON.parse(
        fs.readFileSync(path.resolve(configDirectory, config.publicKeyFile), 'utf8')
    );
    if (publicMetadata.keyId !== config.keyId) {
        throw new Error('publication and public key IDs do not match');
    }
    return {
        ...config,
        configPath,
        publicKey: publicMetadata.publicKey,
        privateKeyPath: path.resolve(configDirectory, config.privateKeyFile),
        clientRepository: path.resolve(configDirectory, config.clientRepository),
        backendRepository: path.resolve(configDirectory, config.backendRepository),
        gradleUserHome: path.resolve(configDirectory, config.gradleUserHome),
        sourceJar: path.resolve(configDirectory, config.sourceJar)
    };
}

function run(command, args, cwd, options = {}) {
    const result = childProcess.spawnSync(command, args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: options.env ? { ...process.env, ...options.env } : process.env
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        const details = (result.stderr || result.stdout || '').trim();
        throw new Error(`${path.basename(command)} failed${details ? `: ${details}` : ''}`);
    }
    return (result.stdout || '').trim();
}

async function fetchResponse(url, options = {}) {
    return fetch(url, { redirect: 'error', ...options });
}

async function downloadResponse(response, destination) {
    if (!response.body) throw new Error('download response did not contain a body');
    await pipeline(
        Readable.fromWeb(response.body),
        fs.createWriteStream(destination, { flags: 'wx' })
    );
}

async function liveManifest(config, { allowMissing = false } = {}) {
    const response = await fetchResponse(config.manifestUrl, { cache: 'no-store' });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new Error(`live manifest returned HTTP ${response.status}`);
    const envelope = await response.json();
    return verifyReleaseManifest(envelope, {
        expectedChannel: config.channel,
        trustedKeys: { [config.keyId]: config.publicKey }
    });
}

function artifactUrl(config, artifactPath) {
    return new URL(artifactPath, config.publicBaseUrl).toString();
}

function processIsRunning(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
}

// One publication at a time per channel, per machine. Both CLIs rewrite the same live manifest, so
// they share the lock. It does not protect against a second machine (see the runbook).
function acquirePublicationLock(workRoot, channel, command) {
    fs.mkdirSync(workRoot, { recursive: true });
    const lockPath = path.join(workRoot, `${channel}.publish.lock`);
    const record = JSON.stringify({
        pid: process.pid,
        host: os.hostname(),
        command,
        startedAt: new Date().toISOString()
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            fs.writeFileSync(lockPath, `${record}\n`, { flag: 'wx' });
            let released = false;
            return () => {
                if (released) return;
                released = true;
                try {
                    fs.unlinkSync(lockPath);
                } catch (error) {
                    if (error.code !== 'ENOENT') throw error;
                }
            };
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            let holder = null;
            try {
                holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
            } catch (_) {
                holder = null;
            }
            const sameHost = holder && holder.host === os.hostname();
            if (sameHost && Number.isInteger(holder.pid) && !processIsRunning(holder.pid)) {
                // The previous publisher died without releasing it.
                fs.unlinkSync(lockPath);
                continue;
            }
            const who = holder
                ? `${holder.command} (pid ${holder.pid} on ${holder.host}, since ${holder.startedAt})`
                : 'an unreadable lock file';
            throw new Error(
                `another publication holds the ${channel} lock: ${who}. ` +
                `If it is not running, delete ${lockPath} after checking the live manifest.`
            );
        }
    }
    throw new Error(`could not acquire the ${channel} publication lock`);
}

module.exports = {
    acquirePublicationLock,
    artifactUrl,
    downloadResponse,
    fetchResponse,
    launcherRoot,
    liveManifest,
    loadConfiguration,
    run
};
