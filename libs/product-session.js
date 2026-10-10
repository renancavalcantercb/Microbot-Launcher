const os = require('os');
const crypto = require('crypto');

const SESSION_FILE = 'product-session.json';
const ACTIVATION_CODE_PATTERN = /^mbc_act_[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/;

function resolveApiBaseUrl(productConfig, environment = process.env) {
    const configured = environment[productConfig.productApiEnvironmentVariable]
        || productConfig.productApiBaseUrl;
    const parsed = new URL(configured);
    const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocal)) {
        throw new Error('Product API must use HTTPS outside localhost');
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error('Product API URL must not contain credentials, query or fragment');
    }
    return parsed.toString().replace(/\/$/, '');
}

function sessionFileName(apiBaseUrl, productConfig) {
    const defaultApiBaseUrl = resolveApiBaseUrl(productConfig, {});
    if (apiBaseUrl === defaultApiBaseUrl) return SESSION_FILE;

    const environmentId = crypto.createHash('sha256').update(apiBaseUrl).digest('hex').slice(0, 12);
    return `product-session-${environmentId}.json`;
}

class ProductSessionService {
    constructor({ axios, fs, path, productDataDir, productConfig, packageJson, secretStore, installationIdentity, log, environment, onSessionInvalidated }) {
        this.axios = axios;
        this.fs = fs;
        this.path = path;
        this.productDataDir = productDataDir;
        this.packageJson = packageJson;
        this.secretStore = secretStore;
        this.installationIdentity = installationIdentity;
        this.log = log;
        this.apiBaseUrl = resolveApiBaseUrl(productConfig, environment);
        this.log.info?.(`Product API configured: ${this.apiBaseUrl}`);
        this.filePath = path.join(productDataDir, sessionFileName(this.apiBaseUrl, productConfig));
        this.legacyFilePath = path.join(productDataDir, SESSION_FILE);
        this.loadedFromLegacyFile = false;
        this.statusPromise = null;
        this.onSessionInvalidated = typeof onSessionInvalidated === 'function'
            ? onSessionInvalidated
            : () => {};
    }

    async activate(rawCode) {
        const code = String(rawCode || '').trim();
        if (!ACTIVATION_CODE_PATTERN.test(code)) {
            return { authenticated: false, error: 'Invalid activation code.' };
        }
        this.assertSecureStorage();

        try {
            const response = await this.axios.post(`${this.apiBaseUrl}/launcher/activate`, {
                code,
                installationId: this.installationIdentity.getOrCreate(),
                deviceName: os.hostname().slice(0, 80) || 'Windows PC',
                platform: process.platform,
                launcherVersion: this.packageJson.version
            }, {
                timeout: 15000,
                headers: { 'Content-Type': 'application/json' }
            });
            const session = this.validateSession(response.data);
            this.save(session);
            return this.publicStatus(session);
        } catch (error) {
            this.log.warn(`Product activation failed: ${this.safeErrorMessage(error)}`);
            const apiErrorCode = error.response?.data?.error?.code;
            return {
                authenticated: false,
                error: error.response?.status === 400
                    ? apiErrorCode === 'invalid_activation_request'
                        ? 'The launcher sent an incompatible activation request. Restart it with npm.cmd run dev:staging.'
                        : 'The code is invalid, expired, or has already been used.'
                    : error.response?.status === 409
                        ? `The ${error.response?.data?.error?.deviceLimit || 1}-device limit has been reached. Revoke a device on the website.`
                        : 'Could not connect to the authentication service.'
            };
        }
    }

    async status() {
        if (this.statusPromise) return this.statusPromise;

        const operation = this.readStatus();
        this.statusPromise = operation;
        try {
            return await operation;
        } finally {
            if (this.statusPromise === operation) this.statusPromise = null;
        }
    }

    async readStatus() {
        let session;
        try {
            session = this.load();
        } catch (error) {
            this.log.warn(`Could not load product session: ${this.safeErrorMessage(error)}`);
            return { authenticated: false, error: 'The saved session could not be opened.' };
        }
        if (!session) return { authenticated: false };

        const now = Date.now();
        if (Date.parse(session.refreshExpiresAt) <= now) {
            this.clear();
            return { authenticated: false, error: 'Your session has expired. Generate a new code.' };
        }
        if (Date.parse(session.accessExpiresAt) > now + 30000) {
            try {
                const response = await this.axios.get(`${this.apiBaseUrl}/launcher/me`, {
                    timeout: 10000,
                    headers: { Authorization: `Bearer ${session.accessToken}` }
                });
                this.migrateLegacySession(session);
                return this.publicStatus(session, response.data);
            } catch (error) {
                if (error.response?.status !== 401) {
                    this.log.warn(`Product session validation failed: ${this.safeErrorMessage(error)}`);
                    return { authenticated: false, error: 'The session could not be validated right now.' };
                }
            }
        }

        try {
            const response = await this.axios.post(`${this.apiBaseUrl}/launcher/token/refresh`, {
                refreshToken: session.refreshToken
            }, {
                timeout: 15000,
                headers: { 'Content-Type': 'application/json' }
            });
            const refreshed = this.validateSession({ ...response.data, device: session.device });
            this.save(refreshed);
            this.removeLegacySessionAfterMigration();
            const statusResponse = await this.axios.get(`${this.apiBaseUrl}/launcher/me`, {
                timeout: 10000,
                headers: { Authorization: `Bearer ${refreshed.accessToken}` }
            });
            return this.publicStatus(refreshed, statusResponse.data);
        } catch (error) {
            if (
                error.response?.status === 401
                && this.clearIfRefreshTokenMatches(session.refreshToken)
            ) {
                this.notifySessionInvalidated();
            }
            this.log.warn(`Product session refresh failed: ${this.safeErrorMessage(error)}`);
            return {
                authenticated: false,
                error: error.response?.status === 401
                    ? 'Your session has been revoked. Generate a new code.'
                    : 'The session could not be validated right now.'
            };
        }
    }

    async signout() {
        let session = null;
        try {
            session = this.load();
            if (session) {
                await this.axios.post(`${this.apiBaseUrl}/launcher/logout`, {
                    refreshToken: session.refreshToken
                }, { timeout: 5000, headers: { 'Content-Type': 'application/json' } });
            }
        } catch (error) {
            this.log.warn(`Remote product signout failed: ${this.safeErrorMessage(error)}`);
        } finally {
            this.clear();
        }
        return { success: true };
    }

    async createClientTicket() {
        let session = this.load();
        if (!session) {
            const error = new Error('The product session is not connected');
            error.status = 401;
            throw error;
        }

        if (Date.parse(session.accessExpiresAt) <= Date.now() + 30000) {
            const status = await this.status();
            if (!status.authenticated) {
                const error = new Error(status.error || 'The product session is not valid');
                if (!this.load()) error.status = 401;
                throw error;
            }
            session = this.load();
            if (!session) throw new Error('The renewed product session was not saved');
        }

        let response;
        try {
            response = await this.axios.post(
                `${this.apiBaseUrl}/launcher/client-ticket`,
                null,
                {
                    timeout: 15000,
                    headers: { Authorization: `Bearer ${session.accessToken}` }
                }
            );
        } catch (error) {
            if (
                error.response?.status === 401
                && this.clearIfRefreshTokenMatches(session.refreshToken)
            ) {
                this.notifySessionInvalidated();
            }
            throw error;
        }
        const value = response.data;
        if (
            value?.tokenType !== 'Bearer'
            || typeof value.ticket !== 'string'
            || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.ticket)
            || !Number.isFinite(Date.parse(value.expiresAt))
            || typeof value.keyId !== 'string'
            || typeof value.audience !== 'string'
        ) {
            throw new Error('Authentication service returned an invalid client ticket');
        }
        return {
            ticket: value.ticket,
            expiresAt: value.expiresAt,
            keyId: value.keyId,
            audience: value.audience,
            apiBaseUrl: this.apiBaseUrl
        };
    }

    async authorizeReleaseChannel(channel) {
        if (typeof channel !== 'string' || !channel) {
            throw new Error('Release channel is not configured');
        }
        const status = await this.status();
        if (!status.authenticated) {
            throw new Error(status.error || 'Connect your Microbot Cut account to access product releases');
        }
        if (!Array.isArray(status.allowedReleaseChannels)) {
            throw new Error('The authentication service did not provide release channel access');
        }
        if (!status.allowedReleaseChannels.includes(channel)) {
            throw new Error(`Your ${status.releaseCohort || 'stable'} release cohort cannot access the ${channel} channel`);
        }
        return status;
    }

    publicStatus(session, access = {}) {
        const status = {
            authenticated: true,
            device: { id: session.device.id, name: session.device.name },
            accessExpiresAt: session.accessExpiresAt,
            refreshExpiresAt: session.refreshExpiresAt
        };
        if (
            typeof access?.plan?.id === 'string'
            && typeof access.plan.name === 'string'
            && Number.isInteger(access.plan.deviceLimit)
        ) {
            status.plan = {
                id: access.plan.id,
                name: access.plan.name,
                deviceLimit: access.plan.deviceLimit
            };
        }
        if (Array.isArray(access?.entitlements)) {
            status.entitlements = access.entitlements.filter((value) => typeof value === 'string');
        }
		if (['stable', 'beta', 'internal'].includes(access?.releaseCohort)) {
			status.releaseCohort = access.releaseCohort;
		}
		if (Array.isArray(access?.allowedReleaseChannels)) {
			status.allowedReleaseChannels = access.allowedReleaseChannels.filter(
				(value) => typeof value === 'string'
			);
		}
		if (typeof access?.selectedReleaseChannel === 'string') {
			status.selectedReleaseChannel = access.selectedReleaseChannel;
		}
        return status;
    }

    validateSession(value) {
        if (
            !value || value.tokenType !== 'Bearer'
            || typeof value.accessToken !== 'string' || !value.accessToken.startsWith('mbc_at_')
            || typeof value.refreshToken !== 'string' || !value.refreshToken.startsWith('mbc_rt_')
            || !Number.isFinite(Date.parse(value.accessExpiresAt))
            || !Number.isFinite(Date.parse(value.refreshExpiresAt))
            || typeof value.device?.id !== 'string' || typeof value.device?.name !== 'string'
        ) {
            throw new Error('Authentication service returned an invalid session');
        }
        return value;
    }

    assertSecureStorage() {
        if (!this.secretStore?.isAvailable()) {
            throw new Error('Operating system credential encryption is unavailable');
        }
    }

    save(session) {
        this.assertSecureStorage();
        this.fs.mkdirSync(this.productDataDir, { recursive: true });
        const protectedSession = this.secretStore.protect(JSON.stringify(session));
        const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
        this.fs.writeFileSync(temporaryPath, JSON.stringify({ version: 1, session: protectedSession }), 'utf8');
        this.fs.renameSync(temporaryPath, this.filePath);
    }

    load() {
        let sourcePath = this.filePath;
        this.loadedFromLegacyFile = false;
        if (!this.fs.existsSync(sourcePath)) {
            if (this.filePath === this.legacyFilePath || !this.fs.existsSync(this.legacyFilePath)) return null;
            sourcePath = this.legacyFilePath;
            this.loadedFromLegacyFile = true;
        }
        this.assertSecureStorage();
        const document = JSON.parse(this.fs.readFileSync(sourcePath, 'utf8'));
        if (document?.version !== 1 || !document.session) throw new Error('Unsupported product session file');
        return this.validateSession(JSON.parse(this.secretStore.reveal(document.session)));
    }

    migrateLegacySession(session) {
        if (!this.loadedFromLegacyFile || this.filePath === this.legacyFilePath) return;
        this.save(session);
        this.removeLegacySessionAfterMigration();
    }

    removeLegacySessionAfterMigration() {
        if (!this.loadedFromLegacyFile || this.filePath === this.legacyFilePath) return;
        try {
            this.fs.unlinkSync(this.legacyFilePath);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        this.loadedFromLegacyFile = false;
    }

    clear() {
        const pathToRemove = this.loadedFromLegacyFile ? this.legacyFilePath : this.filePath;
        try {
            this.fs.unlinkSync(pathToRemove);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        this.loadedFromLegacyFile = false;
    }

    clearIfRefreshTokenMatches(refreshToken) {
        try {
            const current = this.load();
            if (current?.refreshToken !== refreshToken) return false;
            this.clear();
            return true;
        } catch (error) {
            this.log.warn(`Could not compare product session before clearing it: ${this.safeErrorMessage(error)}`);
            return false;
        }
    }

    notifySessionInvalidated() {
        try {
            this.onSessionInvalidated({
                authenticated: false,
                error: 'Your session has expired or been revoked. Generate a new code.'
            });
        } catch (error) {
            this.log.warn(`Could not notify the launcher about the invalid session: ${this.safeErrorMessage(error)}`);
        }
    }

    safeErrorMessage(error) {
        return error instanceof Error ? error.message : 'Unknown error';
    }
}

module.exports = { ProductSessionService, resolveApiBaseUrl, sessionFileName, SESSION_FILE };
