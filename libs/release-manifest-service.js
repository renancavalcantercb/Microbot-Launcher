const fs = require('fs');
const path = require('path');

const { verifyReleaseManifest } = require('./release-manifest');

const STATE_FILE = 'release-update-state.json';
const STATE_BACKUP_FILE = `${STATE_FILE}.previous`;

class ReleaseManifestService {
    constructor({ axios, productDataDir, settings, log = console }) {
        this.axios = axios;
        this.productDataDir = productDataDir;
        this.settings = settings;
        this.log = log;
        this.lastEnvelope = null;
    }

    statePath() {
        return path.join(this.productDataDir, STATE_FILE);
    }

    readState() {
        const candidates = [
            this.statePath(),
            path.join(this.productDataDir, STATE_BACKUP_FILE)
        ];
        let lastError;
        for (const candidate of candidates) {
            try {
                const value = JSON.parse(fs.readFileSync(candidate, 'utf8'));
                if (value && typeof value === 'object' && !Array.isArray(value)) {
                    return value;
                }
            } catch (error) {
                lastError = error;
            }
        }
        try {
            if (lastError && lastError.code !== 'ENOENT' && lastError.name !== 'SyntaxError') {
                this.log.error(`Failed to read release update state: ${lastError.message}`);
            }
        } catch (_) {
            // Logging must never make update state recovery fail.
        }
        return {};
    }

    writeState(state) {
        fs.mkdirSync(this.productDataDir, { recursive: true });
        const target = this.statePath();
        const backup = path.join(this.productDataDir, STATE_BACKUP_FILE);
        const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
        try {
            fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
                encoding: 'utf8',
                flag: 'wx'
            });
            if (fs.existsSync(target)) {
                try {
                    fs.unlinkSync(backup);
                } catch (error) {
                    if (error.code !== 'ENOENT') throw error;
                }
                fs.renameSync(target, backup);
            }
            try {
                fs.renameSync(temporary, target);
            } catch (error) {
                if (!fs.existsSync(target) && fs.existsSync(backup)) {
                    fs.renameSync(backup, target);
                }
                throw error;
            }
            try {
                fs.unlinkSync(backup);
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
        } catch (error) {
            try {
                fs.unlinkSync(temporary);
            } catch (_) {}
            throw error;
        }
    }

    resolveArtifactUrl(artifactPath) {
        const url = new URL(artifactPath, this.settings.artifactBaseUrl);
        if (url.protocol !== 'https:' || url.username || url.password) {
            throw new Error('signed artifact path did not resolve to a safe HTTPS URL');
        }
        return url;
    }

    async fetchCurrent() {
        if (!this.settings.enabled) {
            throw new Error('release updates are disabled');
        }
        let response;
        try {
            response = await this.axios.get(this.settings.manifestUrl, {
                responseType: 'json',
                timeout: 15000
            });
        } catch (error) {
            const cached = this.getLocallyAccepted();
            if (cached) {
                this.log.warn?.(
                    `Signed release manifest is unavailable; using the locally accepted ${this.settings.channel} release.`
                );
                return cached;
            }
            throw error;
        }
        const payload = verifyReleaseManifest(response.data, {
            expectedChannel: this.settings.channel,
            trustedKeys: this.settings.trustedKeys
        });
        this.lastEnvelope = response.data;
        const state = this.readState();
        const previousSequence = state[this.settings.channel]?.highestSequence || 0;
        if (payload.sequence < previousSequence) {
            throw new Error(
                `release manifest sequence ${payload.sequence} is older than accepted sequence ${previousSequence}`
            );
        }
        if (
            payload.sequence > previousSequence ||
            !state[this.settings.channel]?.currentEnvelope
        ) {
            this.writeState({
                ...state,
                [this.settings.channel]: {
                    highestSequence: payload.sequence,
                    acceptedAt: new Date().toISOString(),
                    currentEnvelope: response.data
                }
            });
        }
        return payload;
    }

    getLocallyAccepted() {
        const channelState = this.readState()[this.settings.channel];
        if (!channelState?.currentEnvelope) return null;
        try {
            const payload = this.verifyEnvelope(channelState.currentEnvelope);
            if (payload.sequence !== channelState.highestSequence) {
                throw new Error('cached release sequence does not match accepted state');
            }
            this.lastEnvelope = channelState.currentEnvelope;
            return payload;
        } catch (error) {
            this.log.error?.(`Rejected cached signed release manifest: ${error.message}`);
            return null;
        }
    }

    getLocallyAcceptedEnvelope() {
        return this.lastEnvelope || this.readState()[this.settings.channel]?.currentEnvelope || null;
    }

    verifyEnvelope(envelope) {
        return verifyReleaseManifest(envelope, {
            expectedChannel: this.settings.channel,
            trustedKeys: this.settings.trustedKeys
        });
    }
}

module.exports = {
    ReleaseManifestService,
    STATE_FILE,
    STATE_BACKUP_FILE
};
