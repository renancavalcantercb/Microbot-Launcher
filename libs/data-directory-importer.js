const crypto = require('crypto');
const { parseClientJar } = require('./client-jars');
const { convertLegacyAccounts, ACCOUNT_SCHEMA_VERSION } = require('./account-repository');

const IMPORT_MARKER = '.import-complete.json';
const IMPORT_SCHEMA_VERSION = 1;
const ACCOUNTS_FILE = 'accounts.json';
const IMPORTABLE_JSON_FILES = new Set([
    ACCOUNTS_FILE,
    'clients_jar_ttl.json',
    'downloaded_clients.json',
    'non-jagex-preferred-profile.json',
    'resource_versions.json'
]);

function isImportableFile(name) {
    return IMPORTABLE_JSON_FILES.has(name) || Boolean(parseClientJar(name));
}

function sha256(fs, filePath) {
    return crypto
        .createHash('sha256')
        .update(fs.readFileSync(filePath))
        .digest('hex');
}

function isSchema2Document(parsed) {
    return Boolean(
        parsed &&
            !Array.isArray(parsed) &&
            parsed.schemaVersion === ACCOUNT_SCHEMA_VERSION &&
            Array.isArray(parsed.accounts) &&
            parsed.sessions &&
            typeof parsed.sessions === 'object' &&
            !Array.isArray(parsed.sessions)
    );
}

/**
 * Imports data from the original Microbot directory (the legacy directory) into the Cut product
 * directory. The legacy directory is only ever read: nothing under it is created, changed or
 * removed, on success or on failure. Accounts are never copied as a file; they are read into
 * memory and written straight into schema 2, with every session protected by the secret store.
 */
class DataDirectoryImporter {
    constructor({
        fs,
        path,
        legacyDataDir,
        productDataDir,
        productId,
        log,
        secretStore = null,
        createSessionRef
    }) {
        this.fs = fs;
        this.path = path;
        this.legacyDataDir = path.resolve(legacyDataDir);
        this.productDataDir = path.resolve(productDataDir);
        this.productId = productId;
        this.log = log;
        this.secretStore = secretStore;
        this.createSessionRef = createSessionRef;
    }

    markerPath(directory = this.productDataDir) {
        return this.path.join(directory, IMPORT_MARKER);
    }

    productAccountsPath() {
        return this.path.join(this.productDataDir, ACCOUNTS_FILE);
    }

    // The product directory already holds Cut data of its own that an import must not replace.
    hasProductData() {
        return (
            this.hasCompletedImport() || this.fs.existsSync(this.productAccountsPath())
        );
    }

    status() {
        const importComplete = this.hasCompletedImport();
        const productHasData = this.hasProductData();
        let offerImport = false;
        if (!productHasData) {
            try {
                offerImport = this.listImportableFiles().length > 0;
            } catch (_) {
                offerImport = false;
            }
        }
        return {
            active: 'product',
            legacyExists: this.fs.existsSync(this.legacyDataDir),
            productExists: this.fs.existsSync(this.productDataDir),
            importComplete,
            productHasData,
            offerImport
        };
    }

    hasCompletedImport() {
        try {
            const marker = JSON.parse(
                this.fs.readFileSync(this.markerPath(), 'utf8')
            );
            return (
                marker.schemaVersion === IMPORT_SCHEMA_VERSION &&
                marker.productId === this.productId &&
                Array.isArray(marker.files)
            );
        } catch (_) {
            return false;
        }
    }

    listImportableFiles() {
        if (!this.fs.existsSync(this.legacyDataDir)) {
            throw new Error('Legacy data directory does not exist');
        }
        return this.fs
            .readdirSync(this.legacyDataDir, { withFileTypes: true })
            .filter(
                (entry) =>
                    entry.isFile() &&
                    !entry.isSymbolicLink() &&
                    isImportableFile(entry.name)
            )
            .map((entry) => entry.name)
            .sort();
    }

    // Returns { handling, document } where document is the schema 2 object to write, or null.
    // `expected` maps each sessionRef to the session value, kept in memory for the verification.
    prepareAccounts() {
        const source = this.path.join(this.legacyDataDir, ACCOUNTS_FILE);
        const parsed = JSON.parse(this.fs.readFileSync(source, 'utf8'));
        const expected = new Map();

        if (Array.isArray(parsed)) {
            if (parsed.length === 0) return { handling: 'none', document: null };
            const { accounts, sessions } = convertLegacyAccounts(
                parsed,
                this.secretStore,
                this.createSessionRef
            );
            for (const account of parsed) {
                const converted = accounts.find(
                    (candidate) => candidate.accountId === account.accountId
                );
                expected.set(converted.sessionRef, account.sessionId);
            }
            return {
                handling: 'converted',
                expected,
                document: { schemaVersion: ACCOUNT_SCHEMA_VERSION, accounts, sessions }
            };
        }

        if (!isSchema2Document(parsed)) {
            throw new Error('Legacy accounts file has an unsupported format');
        }
        if (parsed.accounts.length === 0) return { handling: 'none', document: null };
        if (!this.secretStore || !this.secretStore.isAvailable()) {
            throw new Error('Secure account storage is unavailable');
        }

        // An existing schema 2 file is only usable if this install can decrypt every session:
        // the key belongs to the app that wrote it. If not, nothing from the file is imported.
        const sessions = {};
        for (const [sessionRef, entry] of Object.entries(parsed.sessions)) {
            let value;
            try {
                value = this.secretStore.reveal(entry);
            } catch (_) {
                return { handling: 'undecryptable', document: null };
            }
            if (typeof value !== 'string' || value.length === 0) {
                return { handling: 'undecryptable', document: null };
            }
            const protectedSession = this.secretStore.protect(value);
            if (this.secretStore.reveal(protectedSession) !== value) {
                throw new Error('Protected Jagex session verification failed');
            }
            sessions[sessionRef] = protectedSession;
            expected.set(sessionRef, value);
        }
        for (const account of parsed.accounts) {
            if (
                !account ||
                typeof account.accountId !== 'string' ||
                typeof account.sessionRef !== 'string' ||
                !sessions[account.sessionRef] ||
                Object.prototype.hasOwnProperty.call(account, 'sessionId')
            ) {
                return { handling: 'undecryptable', document: null };
            }
        }
        return {
            handling: 'carried',
            expected,
            document: {
                schemaVersion: ACCOUNT_SCHEMA_VERSION,
                accounts: parsed.accounts,
                sessions
            }
        };
    }

    writeAccounts(prepared, destination) {
        this.fs.writeFileSync(
            destination,
            JSON.stringify(prepared.document, null, 2),
            'utf8'
        );
        const written = JSON.parse(this.fs.readFileSync(destination, 'utf8'));
        if (
            written.schemaVersion !== ACCOUNT_SCHEMA_VERSION ||
            written.accounts.some((account) =>
                Object.prototype.hasOwnProperty.call(account, 'sessionId')
            )
        ) {
            throw new Error('Imported accounts file verification failed');
        }
        for (const account of written.accounts) {
            const entry = written.sessions[account.sessionRef];
            if (
                !entry ||
                this.secretStore.reveal(entry) !== prepared.expected.get(account.sessionRef)
            ) {
                throw new Error('Imported Jagex session verification failed');
            }
        }
    }

    importLegacyData() {
        if (this.hasCompletedImport()) {
            return { imported: false, alreadyImported: true };
        }
        if (this.fs.existsSync(this.productAccountsPath())) {
            throw new Error(
                'The product directory already has its own accounts; nothing was imported'
            );
        }

        const files = this.listImportableFiles();
        if (files.length === 0) {
            throw new Error('No supported legacy data files were found');
        }

        const stagingDirectory = `${this.productDataDir}.import-${process.pid}-${Date.now()}`;
        const importedFiles = [];
        const skippedExisting = [];
        const moved = [];
        let accountsHandling = 'none';
        try {
            this.fs.mkdirSync(stagingDirectory, { recursive: false });
            for (const name of files) {
                const source = this.path.join(this.legacyDataDir, name);
                const destination = this.path.join(stagingDirectory, name);
                if (name === ACCOUNTS_FILE) {
                    const prepared = this.prepareAccounts();
                    accountsHandling = prepared.handling;
                    if (prepared.document) {
                        this.writeAccounts(prepared, destination);
                        importedFiles.push({ name, handling: prepared.handling });
                    }
                    continue;
                }
                if (this.fs.existsSync(this.path.join(this.productDataDir, name))) {
                    skippedExisting.push(name);
                    continue;
                }
                const sourceHash = sha256(this.fs, source);
                this.fs.copyFileSync(source, destination);
                const destinationHash = sha256(this.fs, destination);
                if (sourceHash !== destinationHash) {
                    throw new Error(`Imported file verification failed: ${name}`);
                }
                importedFiles.push({ name, sha256: destinationHash });
            }

            // The marker carries file names, hashes of non-credential files and how the accounts
            // were handled; never a token, a session id or a credential hash.
            const marker = {
                schemaVersion: IMPORT_SCHEMA_VERSION,
                productId: this.productId,
                importedAt: new Date().toISOString(),
                sourceDirectoryName: this.path.basename(this.legacyDataDir),
                accounts: accountsHandling,
                files: importedFiles
            };
            this.fs.writeFileSync(
                this.markerPath(stagingDirectory),
                JSON.stringify(marker, null, 2),
                'utf8'
            );

            // Move into the product directory; the marker goes last so a failure never leaves a
            // completed-looking import behind.
            this.fs.mkdirSync(this.productDataDir, { recursive: true });
            for (const entry of importedFiles) {
                const target = this.path.join(this.productDataDir, entry.name);
                this.fs.renameSync(this.path.join(stagingDirectory, entry.name), target);
                moved.push(target);
            }
            const markerTarget = this.markerPath();
            this.fs.renameSync(this.markerPath(stagingDirectory), markerTarget);
            moved.push(markerTarget);
            this.fs.rmSync(stagingDirectory, { recursive: true, force: true });

            this.log.info(
                `Imported ${importedFiles.length} data file(s) into the product directory (accounts: ${accountsHandling}).`
            );
            return {
                imported: true,
                files: importedFiles.map((entry) => entry.name),
                accounts: accountsHandling,
                skippedExisting,
                restartRequired: true
            };
        } catch (error) {
            // Only what this attempt created is removed: files it moved in and its staging directory.
            for (const target of moved) {
                try {
                    this.fs.rmSync(target, { force: true });
                } catch (_) {}
            }
            try {
                this.fs.rmSync(stagingDirectory, {
                    recursive: true,
                    force: true
                });
            } catch (_) {}
            throw error;
        }
    }
}

module.exports = {
    DataDirectoryImporter,
    IMPORT_MARKER,
    IMPORT_SCHEMA_VERSION,
    IMPORTABLE_JSON_FILES,
    isImportableFile
};
