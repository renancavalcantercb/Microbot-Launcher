const crypto = require('crypto');

const INSTALLATION_FILE = 'installation.json';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class InstallationIdentity {
    constructor({ fs, path, productDataDir }) {
        this.fs = fs;
        this.path = path;
        this.productDataDir = productDataDir;
        this.filePath = path.join(productDataDir, INSTALLATION_FILE);
    }

    getOrCreate() {
        const existing = this.read();
        if (existing) return existing;

        const installationId = crypto.randomUUID();
        this.fs.mkdirSync(this.productDataDir, { recursive: true });
        const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
        this.fs.writeFileSync(
            temporaryPath,
            JSON.stringify({ version: 1, installationId }, null, 2),
            'utf8'
        );
        this.fs.renameSync(temporaryPath, this.filePath);
        return installationId;
    }

    read() {
        if (!this.fs.existsSync(this.filePath)) return null;
        const document = JSON.parse(this.fs.readFileSync(this.filePath, 'utf8'));
        if (document?.version !== 1 || !UUID_PATTERN.test(document.installationId)) {
            throw new Error('Unsupported or invalid installation identity');
        }
        return document.installationId;
    }
}

module.exports = { InstallationIdentity, INSTALLATION_FILE, UUID_PATTERN };
