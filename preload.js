const { contextBridge, ipcRenderer } = require('electron');
const productConfig = require('./product-config.js');

contextBridge.exposeInMainWorld('electron', {
    product: productConfig,
    closeLauncher: () => ipcRenderer.invoke('close-launcher'),
    minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
    maximizeWindow: () => ipcRenderer.invoke('maximize-window'),
    startAuthFlow: () => ipcRenderer.invoke('start-auth-flow'),
    cancelAuthFlow: () => ipcRenderer.invoke('cancel-auth-flow'),
    downloadMicrobotLauncher: () =>
        ipcRenderer.invoke('download-microbot-launcher'),
    downloadClient: (version) => ipcRenderer.invoke('download-client', version),
    readProperties: () => ipcRenderer.invoke('read-properties'),
    writeProperties: (data) => ipcRenderer.invoke('write-properties', data),
    fetchLauncherVersion: () => ipcRenderer.invoke('fetch-launcher-version'), //jagex launcher
    fetchClientVersion: () => ipcRenderer.invoke('fetch-client-version'),
    openLauncher: () => ipcRenderer.invoke('open-launcher'),
    openClient: (version, proxy, accountId, ramPreference) =>
        ipcRenderer.invoke(
            'open-client',
            version,
            proxy,
            accountId,
            ramPreference
        ),
    readAccounts: () => ipcRenderer.invoke('read-accounts'),
    deleteAccount: (accountId) =>
        ipcRenderer.invoke('delete-account', accountId),
    removeAccounts: () => ipcRenderer.invoke('remove-accounts'),
    setProfileJagexAccount: (account, profile) =>
        ipcRenderer.invoke('set-profile-jagex', account, profile),
    setProfileNoJagexAccount: (profile) =>
        ipcRenderer.invoke('set-profile-no-jagex', profile),
    readNonJagexProfile: () => ipcRenderer.invoke('read-non-jagex-profile'),
    clientExists: (version) => ipcRenderer.invoke('client-exists', version),
    launcherExists: () => ipcRenderer.invoke('launcher-exists'),
    checkFileChange: () => ipcRenderer.invoke('check-file-change'),
    playNoJagexAccount: (version, proxy, ramPreference) =>
        ipcRenderer.invoke(
            'play-no-jagex-account',
            version,
            proxy,
            ramPreference
        ),
    listJars: () => ipcRenderer.invoke('list-jars'),
    listClientJars: (latestVersion) =>
        ipcRenderer.invoke('list-client-jars', latestVersion),
    listProfiles: () => ipcRenderer.invoke('list-profiles'),
    launcherVersion: () => ipcRenderer.invoke('launcher-version'),
    logError: (message) => ipcRenderer.invoke('log-error', message),
    errorAlert: (options) => ipcRenderer.invoke('error-alert', options),
    showConfirmationDialog: (
        message,
        detail,
        title,
        yesButton,
        noButton,
        options
    ) =>
        ipcRenderer.invoke(
            'show-confirmation-dialog',
            message,
            detail,
            title,
            yesButton,
            noButton,
            options
        ),
    openLocation: (locationKey) =>
        ipcRenderer.invoke('open-location', locationKey),
    dataDirectoryStatus: () => ipcRenderer.invoke('data-directory-status'),
    importLegacyData: () => ipcRenderer.invoke('import-legacy-data'),
    relaunchLauncher: () => ipcRenderer.invoke('relaunch-launcher'),
    cleanUnusedClients: (latestVersion) =>
        ipcRenderer.invoke('cleanup-unused-clients-jar', latestVersion),
    updateClientJarTTL: (version) =>
        ipcRenderer.invoke('update-client-jar-ttl', version),
    refreshAccounts: () => ipcRenderer.invoke('refresh-accounts'),
    auth: {
        signup: (credentials) => ipcRenderer.invoke('auth:signup', credentials),
        signin: (credentials) => ipcRenderer.invoke('auth:signin', credentials),
        signout: () => ipcRenderer.invoke('auth:signout'),
        changePassword: (payload) =>
            ipcRenderer.invoke('auth:changepw', payload),
        status: () => ipcRenderer.invoke('auth:status')
    },
    productSession: {
        activate: (code) => ipcRenderer.invoke('product-session:activate', code),
        status: () => ipcRenderer.invoke('product-session:status'),
        signout: () => ipcRenderer.invoke('product-session:signout'),
        openAccount: () => ipcRenderer.invoke('product-session:open-account'),
        onChanged: (callback) => {
            const listener = (_event, status) => callback(status);
            ipcRenderer.on('product-session:changed', listener);
            return () => ipcRenderer.removeListener('product-session:changed', listener);
        }
    },
    clientRelease: {
        status: () => ipcRenderer.invoke('client-release:status'),
        rollback: () => ipcRenderer.invoke('client-release:rollback'),
        onChanged: (callback) => {
            const listener = (_event, status) => callback(status);
            ipcRenderer.on('client-release:changed', listener);
            return () => ipcRenderer.removeListener('client-release:changed', listener);
        }
    },
    ipcRenderer: {
        send: (channel, data) => ipcRenderer.send(channel, data),
        receive: (channel, func) =>
            ipcRenderer.on(channel, (event, ...args) => func(event, ...args)),
        invoke: (channel, data) => ipcRenderer.invoke(channel, data)
    }
});
