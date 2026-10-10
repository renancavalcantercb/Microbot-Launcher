const {
    ElectronSafeStorageSecretStore,
    PROTECTION_SCHEME
} = require('../libs/account-secret-store');

function fakeSafeStorage(available = true) {
    return {
        isEncryptionAvailable: jest.fn(() => available),
        encryptString: jest.fn((value) =>
            Buffer.from(`protected:${value}`, 'utf8')
        ),
        decryptString: jest.fn((value) =>
            value.toString('utf8').replace(/^protected:/, '')
        )
    };
}

describe('ElectronSafeStorageSecretStore', () => {
    test('protects and reveals a fake Jagex session', () => {
        const safeStorage = fakeSafeStorage();
        const store = new ElectronSafeStorageSecretStore(safeStorage);

        const protectedValue = store.protect('fake-session-token');

        expect(protectedValue).toEqual({
            protection: PROTECTION_SCHEME,
            value: Buffer.from('protected:fake-session-token').toString(
                'base64'
            )
        });
        expect(JSON.stringify(protectedValue)).not.toContain(
            'fake-session-token'
        );
        expect(store.reveal(protectedValue)).toBe('fake-session-token');
    });

    test('fails closed when operating system encryption is unavailable', () => {
        const store = new ElectronSafeStorageSecretStore(
            fakeSafeStorage(false)
        );

        expect(() => store.protect('fake-session-token')).toThrow(
            /encryption is unavailable/
        );
        expect(() =>
            store.reveal({
                protection: PROTECTION_SCHEME,
                value: Buffer.from('anything').toString('base64')
            })
        ).toThrow(/encryption is unavailable/);
    });

    test('rejects unknown formats and malformed base64', () => {
        const store = new ElectronSafeStorageSecretStore(fakeSafeStorage());

        expect(() =>
            store.reveal({ protection: 'plain-text', value: 'secret' })
        ).toThrow(/invalid protected secret/);
        expect(() =>
            store.reveal({ protection: PROTECTION_SCHEME, value: '***' })
        ).toThrow(/valid base64/);
    });
});
