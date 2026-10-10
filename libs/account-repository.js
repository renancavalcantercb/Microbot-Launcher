const ACCOUNT_SCHEMA_VERSION = 2;
const { randomUUID } = require('crypto');

function publicAccount(account) {
    const result = {
        accountId: account.accountId,
        displayName: account.displayName || 'Not set'
    };
    if (account.createdOn !== undefined) result.createdOn = account.createdOn;
    if (account.profile !== undefined) result.profile = account.profile;
    return result;
}

class AccountRepository {
    constructor({
        fs,
        path,
        microbotDir,
        log,
        secretStore = null,
        createSessionRef = randomUUID
    }) {
        this.fs = fs;
        this.path = path;
        this.log = log;
        this.secretStore = secretStore;
        this.createSessionRef = createSessionRef;
        this.filePath = path.resolve(microbotDir, 'accounts.json');
    }

    exists() {
        return this.fs.existsSync(this.filePath);
    }

    listPublicAccounts() {
        const document = this.readDocument();
        const accounts = [...document.accounts].sort(
            (a, b) => new Date(b.createdOn) - new Date(a.createdOn)
        );
        const displayNames = new Set();

        return accounts
            .filter((account) => {
                if (!account.displayName) {
                    return true;
                }
                if (displayNames.has(account.displayName)) {
                    return false;
                }
                displayNames.add(account.displayName);
                return true;
            })
            .map(publicAccount);
    }

    getAccountForLaunch(accountId) {
        if (typeof accountId !== 'string' || accountId.length === 0) {
            return null;
        }
        const document = this.readDocument();
        const account = document.accounts.find(
            (candidate) => candidate.accountId === accountId
        );
        if (!account) {
            return null;
        }

        const sessionId = document.legacy
            ? account.sessionId
            : this.revealSession(document, account.sessionRef);
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
            throw new Error('The selected account has no Jagex session');
        }
        return { ...publicAccount(account), sessionId };
    }

    listSessionIds() {
        const document = this.readDocument();
        const sessions = document.legacy
            ? document.accounts.map((account) => account.sessionId)
            : Object.values(document.sessions).map((entry) =>
                  this.revealProtectedSession(entry)
              );
        return [...new Set(sessions.filter(Boolean))];
    }

    setProfile(accountId, profile) {
        const document = this.readDocument();
        const account = document.accounts.find(
            (candidate) => candidate.accountId === accountId
        );
        if (!account) {
            return false;
        }
        account.profile = profile;
        this.writeDocument(document);
        return true;
    }

    deleteAccount(accountId) {
        const document = this.readDocument();
        const account = document.accounts.find(
            (candidate) => candidate.accountId === accountId
        );
        if (!account) {
            return false;
        }

        document.accounts = document.accounts.filter(
            (candidate) => candidate.accountId !== accountId
        );
        if (
            !document.legacy &&
            !document.accounts.some(
                (candidate) => candidate.sessionRef === account.sessionRef
            )
        ) {
            delete document.sessions[account.sessionRef];
        }
        this.writeDocument(document);
        return true;
    }

    removeAll() {
        if (this.exists()) {
            this.fs.unlinkSync(this.filePath);
        }
    }

    migrateLegacy() {
        const document = this.readDocument();
        if (!document.legacy) {
            return { migrated: false, accounts: document.accounts.length };
        }
        if (
            !this.secretStore ||
            typeof this.secretStore.isAvailable !== 'function' ||
            !this.secretStore.isAvailable()
        ) {
            throw new Error('Secure account storage is unavailable');
        }

        const sessionRefs = new Map();
        const sessions = {};
        const accounts = document.accounts.map((account) => {
            if (
                !account ||
                typeof account.accountId !== 'string' ||
                account.accountId.length === 0 ||
                typeof account.sessionId !== 'string' ||
                account.sessionId.length === 0
            ) {
                throw new Error('Legacy accounts file contains an invalid account');
            }

            let sessionRef = sessionRefs.get(account.sessionId);
            if (!sessionRef) {
                for (let attempt = 0; attempt < 100; attempt++) {
                    sessionRef = this.createSessionRef();
                    if (
                        typeof sessionRef === 'string' &&
                        sessionRef.length > 0 &&
                        !sessions[sessionRef]
                    ) {
                        break;
                    }
                    sessionRef = null;
                }
                if (!sessionRef) {
                    throw new Error('Could not create a unique Jagex session reference');
                }
                const protectedSession = this.secretStore.protect(account.sessionId);
                if (this.secretStore.reveal(protectedSession) !== account.sessionId) {
                    throw new Error('Protected Jagex session verification failed');
                }
                sessionRefs.set(account.sessionId, sessionRef);
                sessions[sessionRef] = protectedSession;
            }

            const { sessionId, ...metadata } = account;
            return { ...metadata, sessionRef };
        });

        const migrated = {
            legacy: false,
            schemaVersion: ACCOUNT_SCHEMA_VERSION,
            accounts,
            sessions
        };
        this.writeDocument(migrated, (temporaryPath) => {
            const parsed = JSON.parse(
                this.fs.readFileSync(temporaryPath, 'utf8')
            );
            if (
                parsed.schemaVersion !== ACCOUNT_SCHEMA_VERSION ||
                parsed.accounts.some((account) =>
                    Object.prototype.hasOwnProperty.call(account, 'sessionId')
                )
            ) {
                throw new Error('Migrated accounts file verification failed');
            }
            for (const account of document.accounts) {
                const migratedAccount = parsed.accounts.find(
                    (candidate) => candidate.accountId === account.accountId
                );
                const protectedSession =
                    migratedAccount && parsed.sessions[migratedAccount.sessionRef];
                if (
                    !protectedSession ||
                    this.secretStore.reveal(protectedSession) !== account.sessionId
                ) {
                    throw new Error('Migrated Jagex session verification failed');
                }
            }
        });
        return {
            migrated: true,
            accounts: accounts.length,
            sessions: Object.keys(sessions).length
        };
    }

    storeFetchedAccounts(fetchedAccounts, sessionId, now) {
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
            throw new Error('A non-empty Jagex session is required');
        }
        if (!Array.isArray(fetchedAccounts)) {
            throw new Error('Jagex account response is invalid');
        }

        const document = this.readDocument();
        if (document.legacy) {
            throw new Error('Legacy accounts must be migrated before updating');
        }
        if (!this.secretStore) {
            throw new Error('Secure account storage is unavailable');
        }

        const validFetched = fetchedAccounts.filter(
            (account) =>
                account &&
                typeof account.accountId === 'string' &&
                account.accountId.length > 0
        );
        if (validFetched.length === 0) {
            return { added: 0, updated: 0 };
        }

        let sessionRef = Object.keys(document.sessions).find(
            (candidate) =>
                this.revealProtectedSession(document.sessions[candidate]) ===
                sessionId
        );
        let protectedSession = null;
        if (!sessionRef) {
            sessionRef = this.uniqueSessionRef(document.sessions);
            protectedSession = this.secretStore.protect(sessionId);
            if (this.secretStore.reveal(protectedSession) !== sessionId) {
                throw new Error('Protected Jagex session verification failed');
            }
        }

        const indexById = new Map(
            document.accounts.map((account, index) => [account.accountId, index])
        );
        let added = 0;
        let updated = 0;
        for (const fetched of validFetched) {
            const metadata = { ...fetched };
            delete metadata.sessionId;
            delete metadata.sessionRef;
            const index = indexById.get(metadata.accountId);
            if (index === undefined) {
                indexById.set(metadata.accountId, document.accounts.length);
                document.accounts.push({
                    ...metadata,
                    sessionRef,
                    createdOn: now
                });
                added++;
                continue;
            }

            const current = document.accounts[index];
            const next = { ...current, ...metadata, sessionRef };
            if (
                typeof metadata.displayName !== 'string' ||
                metadata.displayName.trim().length === 0
            ) {
                next.displayName = current.displayName;
            }
            if (JSON.stringify(next) !== JSON.stringify(current)) {
                document.accounts[index] = next;
                updated++;
            }
        }

        if (added > 0 || updated > 0) {
            if (protectedSession) {
                document.sessions[sessionRef] = protectedSession;
            }
            const referencedSessions = new Set(
                document.accounts.map((account) => account.sessionRef)
            );
            for (const candidate of Object.keys(document.sessions)) {
                if (!referencedSessions.has(candidate)) {
                    delete document.sessions[candidate];
                }
            }
            this.writeDocument(document);
        }
        return { added, updated };
    }

    uniqueSessionRef(sessions) {
        for (let attempt = 0; attempt < 100; attempt++) {
            const sessionRef = this.createSessionRef();
            if (
                typeof sessionRef === 'string' &&
                sessionRef.length > 0 &&
                !sessions[sessionRef]
            ) {
                return sessionRef;
            }
        }
        throw new Error('Could not create a unique Jagex session reference');
    }

    readDocument() {
        if (!this.exists()) {
            return { legacy: true, accounts: [] };
        }
        const parsed = JSON.parse(this.fs.readFileSync(this.filePath, 'utf8'));
        if (Array.isArray(parsed)) {
            return { legacy: true, accounts: parsed };
        }
        if (
            !parsed ||
            parsed.schemaVersion !== ACCOUNT_SCHEMA_VERSION ||
            !Array.isArray(parsed.accounts) ||
            !parsed.sessions ||
            typeof parsed.sessions !== 'object' ||
            Array.isArray(parsed.sessions)
        ) {
            throw new Error('Unsupported or corrupted accounts file');
        }
        return {
            legacy: false,
            schemaVersion: ACCOUNT_SCHEMA_VERSION,
            accounts: parsed.accounts,
            sessions: parsed.sessions
        };
    }

    revealSession(document, sessionRef) {
        if (typeof sessionRef !== 'string' || !document.sessions[sessionRef]) {
            throw new Error('The selected account references a missing session');
        }
        return this.revealProtectedSession(document.sessions[sessionRef]);
    }

    revealProtectedSession(entry) {
        if (!this.secretStore) {
            throw new Error('Secure account storage is unavailable');
        }
        return this.secretStore.reveal(entry);
    }

    writeDocument(document, verifyTemporaryFile = null) {
        const serializable = document.legacy
            ? document.accounts
            : {
                  schemaVersion: ACCOUNT_SCHEMA_VERSION,
                  accounts: document.accounts,
                  sessions: document.sessions
              };
        const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
        try {
            this.fs.writeFileSync(
                temporaryPath,
                JSON.stringify(serializable, null, 2),
                'utf8'
            );
            if (verifyTemporaryFile) {
                verifyTemporaryFile(temporaryPath);
            }
            this.fs.renameSync(temporaryPath, this.filePath);
        } catch (error) {
            try {
                this.fs.unlinkSync(temporaryPath);
            } catch (_) {}
            this.log.error(`Failed to update accounts file: ${error.message}`);
            throw error;
        }
    }
}

module.exports = {
    AccountRepository,
    ACCOUNT_SCHEMA_VERSION,
    publicAccount
};
