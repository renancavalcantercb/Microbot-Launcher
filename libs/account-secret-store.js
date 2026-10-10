const PROTECTION_SCHEME = 'electron-safe-storage-v1';

class ElectronSafeStorageSecretStore {
    constructor(safeStorage) {
        if (!safeStorage) {
            throw new Error('Electron safeStorage is required');
        }
        this.safeStorage = safeStorage;
    }

    isAvailable() {
        return this.safeStorage.isEncryptionAvailable() === true;
    }

    protect(value) {
        if (typeof value !== 'string' || value.length === 0) {
            throw new Error('A non-empty secret is required');
        }
        if (!this.isAvailable()) {
            throw new Error('Operating system credential encryption is unavailable');
        }

        return {
            protection: PROTECTION_SCHEME,
            value: this.safeStorage.encryptString(value).toString('base64')
        };
    }

    reveal(protectedValue) {
        if (
            !protectedValue ||
            protectedValue.protection !== PROTECTION_SCHEME ||
            typeof protectedValue.value !== 'string' ||
            protectedValue.value.length === 0
        ) {
            throw new Error('Unsupported or invalid protected secret');
        }
        if (!this.isAvailable()) {
            throw new Error('Operating system credential encryption is unavailable');
        }

        const encrypted = Buffer.from(protectedValue.value, 'base64');
        if (
            encrypted.length === 0 ||
            encrypted.toString('base64') !== protectedValue.value
        ) {
            throw new Error('Protected secret is not valid base64');
        }
        return this.safeStorage.decryptString(encrypted);
    }
}

module.exports = {
    ElectronSafeStorageSecretStore,
    PROTECTION_SCHEME
};
