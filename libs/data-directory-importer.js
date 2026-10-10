const crypto = require('crypto');
const { parseClientJar } = require('./client-jars');

const IMPORT_MARKER = '.import-complete.json';
const IMPORT_SCHEMA_VERSION = 1;
const IMPORTABLE_JSON_FILES = new Set([
    'accounts.json',
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

class DataDirectoryImporter {
    constructor({ fs, path, legacyDataDir, productDataDir, productId, log }) {
        this.fs = fs;
        this.path = path;
        this.legacyDataDir = path.resolve(legacyDataDir);
        this.productDataDir = path.resolve(productDataDir);
        this.productId = productId;
        this.log = log;
    }

    markerPath(directory = this.productDataDir) {
        return this.path.join(directory, IMPORT_MARKER);
    }

    status() {
        return {
            active: this.hasCompletedImport() ? 'product' : 'legacy',
            legacyExists: this.fs.existsSync(this.legacyDataDir),
            productExists: this.fs.existsSync(this.productDataDir),
            importComplete: this.hasCompletedImport()
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

    importLegacyData() {
        if (this.hasCompletedImport()) {
            return { imported: false, alreadyImported: true };
        }
        if (this.fs.existsSync(this.productDataDir)) {
            throw new Error(
                'Product data directory already exists without a valid import marker'
            );
        }

        const files = this.listImportableFiles();
        if (files.length === 0) {
            throw new Error('No supported legacy data files were found');
        }

        const stagingDirectory = `${this.productDataDir}.import-${process.pid}-${Date.now()}`;
        const importedFiles = [];
        try {
            this.fs.mkdirSync(stagingDirectory, { recursive: false });
            for (const name of files) {
                const source = this.path.join(this.legacyDataDir, name);
                const destination = this.path.join(stagingDirectory, name);
                const sourceHash = sha256(this.fs, source);
                this.fs.copyFileSync(source, destination);
                const destinationHash = sha256(this.fs, destination);
                if (sourceHash !== destinationHash) {
                    throw new Error(`Imported file verification failed: ${name}`);
                }
                importedFiles.push({ name, sha256: destinationHash });
            }

            const marker = {
                schemaVersion: IMPORT_SCHEMA_VERSION,
                productId: this.productId,
                importedAt: new Date().toISOString(),
                sourceDirectoryName: this.path.basename(this.legacyDataDir),
                files: importedFiles
            };
            this.fs.writeFileSync(
                this.markerPath(stagingDirectory),
                JSON.stringify(marker, null, 2),
                'utf8'
            );
            this.fs.renameSync(stagingDirectory, this.productDataDir);
            this.log.info(
                `Imported ${importedFiles.length} verified data file(s) into the product directory.`
            );
            return {
                imported: true,
                files: importedFiles.map((entry) => entry.name),
                restartRequired: true
            };
        } catch (error) {
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
