const path = require('path');

const DEFAULT_HEALTH_TIMEOUT_MS = 60 * 1000;

class ClientReleaseHealth {
    constructor({
        fs,
        microbotDir,
        releaseStore,
        log = console,
        timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
        onChanged = () => {}
    }) {
        this.fs = fs;
        this.microbotDir = microbotDir;
        this.releaseStore = releaseStore;
        this.log = log;
        this.timeoutMs = timeoutMs;
        this.onChanged = onChanged;
        this.timers = new Map();
    }

    begin(version) {
        if (!this.releaseStore.get(version)) return false;
        this.releaseStore.markPending(version);
        this.clear(version);
        const timer = setTimeout(() => {
            this.fail(version, 'client health acknowledgement timed out');
        }, this.timeoutMs);
        timer.unref?.();
        this.timers.set(version, timer);
        this.log.info(`Client release ${version} is pending health acknowledgement.`);
        this.notifyChanged();
        return true;
    }

    healthy(version) {
        const entry = this.releaseStore.get(version);
        if (!entry) return false;
        this.clear(version);
        this.releaseStore.markHealthy(version);
        this.log.info(`Client release ${version} is healthy and is now the last-known-good release.`);
        this.notifyChanged();
        return true;
    }

    fail(version, reason) {
        const entry = this.releaseStore.get(version);
        if (!entry || entry.health === 'healthy') return false;
        this.clear(version);
        const result = this.releaseStore.markFailed(version, reason);
        this.log.warn(`Client release ${version} failed startup health: ${reason}.`);
        if (result.rollbackVersion) {
            this.selectRollback(result.rollbackVersion);
            this.log.warn(
                `Selected last-known-good client ${result.rollbackVersion} for the next launch.`
            );
        } else {
            this.log.warn('No last-known-good client release is available for automatic rollback.');
        }
        this.notifyChanged();
        return true;
    }

    selectRollback(version) {
        const propertiesPath = path.join(this.microbotDir, 'resource_versions.json');
        let properties = {};
        try {
            properties = JSON.parse(this.fs.readFileSync(propertiesPath, 'utf8'));
        } catch (error) {
            if (error.code !== 'ENOENT') {
                this.log.warn(`Failed to read launcher properties for rollback: ${error.message}`);
            }
        }
        const temporary = `${propertiesPath}.${process.pid}.${Date.now()}.tmp`;
        const backup = `${propertiesPath}.rollback-previous`;
        try {
            this.fs.writeFileSync(
                temporary,
                `${JSON.stringify({
                    ...properties,
                    client: version,
                    version_pref: version
                }, null, 2)}\n`,
                { encoding: 'utf8', flag: 'wx' }
            );
            if (this.fs.existsSync(propertiesPath)) {
                try { this.fs.unlinkSync(backup); } catch (error) {
                    if (error.code !== 'ENOENT') throw error;
                }
                this.fs.renameSync(propertiesPath, backup);
            }
            try {
                this.fs.renameSync(temporary, propertiesPath);
            } catch (error) {
                if (!this.fs.existsSync(propertiesPath) && this.fs.existsSync(backup)) {
                    this.fs.renameSync(backup, propertiesPath);
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

    clear(version) {
        const timer = this.timers.get(version);
        if (timer) clearTimeout(timer);
        this.timers.delete(version);
    }

    notifyChanged() {
        try {
            this.onChanged(this.releaseStore.status());
        } catch (error) {
            this.log.warn?.(`Failed to publish client release health: ${error.message}`);
        }
    }
}

module.exports = { ClientReleaseHealth, DEFAULT_HEALTH_TIMEOUT_MS };
