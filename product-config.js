const productConfig = Object.freeze({
    productId: 'microbot-cut',
    productName: 'Microbot Cut',
    launcherName: 'Microbot Cut Launcher',
    // Keep the legacy Electron runtime name until safeStorage blobs are rewrapped.
    packageName: 'microbot-launcher',
    packageDescription: 'Launcher for the Microbot Cut client',
    shortcutName: 'Microbot Cut Launcher',
    iconFile: 'images/microbot_cut.png',
    appId: 'com.microbotcut.launcher',
    dataDirectoryName: '.microbot-cut',
    legacyDataDirectoryName: '.microbot',
    launcherDataDirectoryName: 'microbot-cut-launcher',
    updateApiBase: null,
    updateFilesBase: null,
    landingPageUrl: null,
    productApiBaseUrl: 'http://localhost:5173/api/v1',
    productApiEnvironmentVariable: 'MICROBOT_CUT_API_BASE_URL',
    clientVersion: '2.6.30',
    releaseUpdates: Object.freeze({ enabled: false }),
    releaseUpdateEnvironmentVariables: Object.freeze({
        enabled: 'MICROBOT_CUT_RELEASE_UPDATES_ENABLED',
        channel: 'MICROBOT_CUT_RELEASE_CHANNEL',
        manifestUrl: 'MICROBOT_CUT_RELEASE_MANIFEST_URL',
        artifactBaseUrl: 'MICROBOT_CUT_RELEASE_ARTIFACT_BASE_URL',
        publicKey: 'MICROBOT_CUT_RELEASE_PUBLIC_KEY',
        publicKeyId: 'MICROBOT_CUT_RELEASE_PUBLIC_KEY_ID'
    }),
    pluginDevelopmentEnvironmentVariable: 'MICROBOT_CUT_PLUGIN_DEV',
    pluginRepositoryEnvironmentVariables: Object.freeze({
        enabled: 'MICROBOT_CUT_PLUGIN_REPOSITORY_ENABLED',
        manifestUrl: 'MICROBOT_CUT_PLUGIN_MANIFEST_URL',
        releasesUrl: 'MICROBOT_CUT_PLUGIN_RELEASES_URL',
        releasesApiUrl: 'MICROBOT_CUT_PLUGIN_RELEASES_API_URL',
        publicKey: 'MICROBOT_CUT_PLUGIN_PUBLIC_KEY',
        publicKeyId: 'MICROBOT_CUT_PLUGIN_PUBLIC_KEY_ID'
    }),
    creditLine: 'Based on Microbot'
});

module.exports = productConfig;
