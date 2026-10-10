const mockExposeInMainWorld = jest.fn();
const mockInvoke = jest.fn();

jest.mock('electron', () => ({
    contextBridge: { exposeInMainWorld: mockExposeInMainWorld },
    ipcRenderer: {
        invoke: mockInvoke,
        send: jest.fn(),
        on: jest.fn()
    }
}));

describe('preload account boundary', () => {
    beforeEach(() => {
        jest.resetModules();
        mockExposeInMainWorld.mockClear();
        mockInvoke.mockClear();
    });

    test('launches by account id and exposes no credential writer', async () => {
        require('../preload');
        const api = mockExposeInMainWorld.mock.calls[0][1];

        await api.openClient(
            'cut-2.6.30',
            { proxyIp: '' },
            'fake-account-id',
            '1g'
        );

        expect(mockInvoke).toHaveBeenCalledWith(
            'open-client',
            'cut-2.6.30',
            { proxyIp: '' },
            'fake-account-id',
            '1g'
        );
        expect(api.overwriteCredentialProperties).toBeUndefined();
    });
});
