const crypto = require('crypto');
const path = require('path');

const STORE_FILE = 'verified-client-releases.json';
const STORE_BACKUP_FILE = `${STORE_FILE}.previous`;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

class VerifiedClientReleaseStore {
    constructor({ fs, productDataDir, log = console, now = () => new Date() }) {
        this.fs = fs;
        this.productDataDir = productDataDir;
        this.log = log;
        this.now = now;
    }

    storePath() {
        return path.join(this.productDataDir, STORE_FILE);
    }

    read() {
        for (const candidate of [
            this.storePath(),
            path.join(this.productDataDir, STORE_BACKUP_FILE)
        ]) {
            try {
                const parsed = JSON.parse(this.fs.readFileSync(candidate, 'utf8'));
                if (parsed?.schemaVersion === 1 && parsed.releases && typeof parsed.releases === 'object') {
                    return parsed;
                }
            } catch (error) {
                if (error.code !== 'ENOENT' && error.name !== 'SyntaxError') {
                    this.log.error?.(`Failed to read verified client release store: ${error.message}`);
                }
            }
        }
        return { schemaVersion: 1, releases: {} };
    }

    write(value) {
        this.fs.mkdirSync(this.productDataDir, { recursive: true });
        const target = this.storePath();
        const backup = path.join(this.productDataDir, STORE_BACKUP_FILE);
        const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
        try {
            this.fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
                encoding: 'utf8',
                flag: 'wx'
            });
            if (this.fs.existsSync(target)) {
                try { this.fs.unlinkSync(backup); } catch (error) {
                    if (error.code !== 'ENOENT') throw error;
                }
                this.fs.renameSync(target, backup);
            }
            try {
                this.fs.renameSync(temporary, target);
            } catch (error) {
                if (!this.fs.existsSync(target) && this.fs.existsSync(backup)) {
                    this.fs.renameSync(backup, target);
                }
                throw error;
            }
            try { this.fs.unlinkSync(backup); } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
        } catch (error) {
            try { this.fs.unlinkSync(temporary); } catch (_) {}
            throw error;
        }
    }

    get(version) {
        return this.read().releases[version] || null;
    }

    status() {
        const state = this.read();
        return {
            lastKnownGoodVersion: state.lastKnownGoodVersion || null,
            releases: Object.values(state.releases)
                .map((entry) => ({
                    version: entry.version,
                    channel: entry.channel,
                    sequence: entry.sequence,
                    health: entry.health || 'verified',
                    verifiedAt: entry.verifiedAt || null,
                    pendingAt: entry.pendingAt || null,
                    healthyAt: entry.healthyAt || null,
                    failedAt: entry.failedAt || null,
                    lastFailure: entry.lastFailure || null,
                    launchAttempts: entry.launchAttempts || 0
                }))
                .sort((left, right) => right.sequence - left.sequence)
        };
    }

    record({ version, fileName, channel, sequence, size, sha256, artifactPath, signedEnvelope }) {
        if (!version || !fileName || !channel || !Number.isSafeInteger(sequence) || sequence < 1 ||
            !Number.isSafeInteger(size) || size <= 0 || !SHA256_PATTERN.test(sha256 || '')) {
            throw new Error('verified client release metadata is invalid');
        }
        const state = this.read();
        const previous = state.releases[version] || {};
        const entry = {
            ...previous,
            version,
            fileName,
            channel,
            sequence,
            size,
            sha256,
            artifactPath,
            signedEnvelope,
            verifiedAt: this.now().toISOString()
        };
        this.write({
            ...state,
            schemaVersion: 1,
            releases: { ...state.releases, [version]: entry }
        });
        return entry;
    }

    markPending(version) {
        const state = this.read();
        const entry = state.releases[version];
        if (!entry) throw new Error(`client ${version} is not registered as a verified release`);
        const updated = {
            ...entry,
            health: 'pending',
            pendingAt: this.now().toISOString(),
            launchAttempts: (entry.launchAttempts || 0) + 1,
            lastFailure: undefined
        };
        this.write({
            ...state,
            releases: { ...state.releases, [version]: updated }
        });
        return updated;
    }

    markHealthy(version) {
        const state = this.read();
        const entry = state.releases[version];
        if (!entry) throw new Error(`client ${version} is not registered as a verified release`);
        const updated = {
            ...entry,
            health: 'healthy',
            healthyAt: this.now().toISOString(),
            lastFailure: undefined
        };
        this.write({
            ...state,
            lastKnownGoodVersion: version,
            releases: { ...state.releases, [version]: updated }
        });
        return updated;
    }

    markFailed(version, reason) {
        const state = this.read();
        const entry = state.releases[version];
        if (!entry) return { release: null, rollbackVersion: state.lastKnownGoodVersion || null };
        const updated = {
            ...entry,
            health: 'failed',
            failedAt: this.now().toISOString(),
            lastFailure: String(reason || 'startup health acknowledgement was not received')
        };
        this.write({
            ...state,
            releases: { ...state.releases, [version]: updated }
        });
        return {
            release: updated,
            rollbackVersion:
                state.lastKnownGoodVersion && state.lastKnownGoodVersion !== version
                    ? state.lastKnownGoodVersion
                    : null
        };
    }

    async verifyFile(entry, filePath) {
        if (!entry || !SHA256_PATTERN.test(entry.sha256 || '')) {
            throw new Error('client release is not present in the verified local registry');
        }
        const hash = crypto.createHash('sha256');
        let bytes = 0;
        try {
            for await (const chunk of this.fs.createReadStream(filePath)) {
                bytes += chunk.length;
                hash.update(chunk);
            }
        } catch (error) {
            if (error.code === 'ENOENT') {
                throw new Error(`verified client file is missing: ${entry.fileName}`);
            }
            throw error;
        }
        const sha256 = hash.digest('hex');
        if (bytes !== entry.size || sha256 !== entry.sha256) {
            throw new Error(
                `client ${entry.version} failed local integrity verification; reinstall this release`
            );
        }
        return { bytes, sha256, path: filePath };
    }
}

module.exports = {
    VerifiedClientReleaseStore,
    STORE_FILE,
    STORE_BACKUP_FILE
};
