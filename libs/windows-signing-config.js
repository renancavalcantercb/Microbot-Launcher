const path = require('path');

const SIGNING_MODES = Object.freeze({
    PFX: 'pfx',
    AZURE: 'azure'
});

function required(environment, name) {
    const value = environment[name];
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`Missing required Windows signing setting: ${name}`);
    }
    return value.trim();
}

function createWindowsProductionConfig(packageBuild, environment = process.env) {
    const mode = required(
        environment,
        'MICROBOT_CUT_WINDOWS_SIGNING_MODE'
    ).toLowerCase();
    const publisherName = required(
        environment,
        'MICROBOT_CUT_WINDOWS_PUBLISHER_NAME'
    );
    const build = JSON.parse(JSON.stringify(packageBuild || {}));

    build.directories = {
        ...(build.directories || {}),
        output: path.join('dist-production')
    };
    build.forceCodeSigning = true;
    build.win = {
        ...(build.win || {}),
        forceCodeSigning: true,
        verifyUpdateCodeSignature: true
    };

    delete build.win.azureSignOptions;
    delete build.win.signtoolOptions;

    if (mode === SIGNING_MODES.PFX) {
        required(environment, 'WIN_CSC_LINK');
        if (!Object.prototype.hasOwnProperty.call(environment, 'WIN_CSC_KEY_PASSWORD')) {
            throw new Error(
                'Missing required Windows signing setting: WIN_CSC_KEY_PASSWORD'
            );
        }
        build.win.signtoolOptions = {
            publisherName: [publisherName],
            signingHashAlgorithms: ['sha256']
        };
    } else if (mode === SIGNING_MODES.AZURE) {
        build.win.azureSignOptions = {
            endpoint: required(
                environment,
                'MICROBOT_CUT_AZURE_SIGNING_ENDPOINT'
            ),
            certificateProfileName: required(
                environment,
                'MICROBOT_CUT_AZURE_CERTIFICATE_PROFILE'
            ),
            codeSigningAccountName: required(
                environment,
                'MICROBOT_CUT_AZURE_SIGNING_ACCOUNT'
            ),
            publisherName
        };
    } else {
        throw new Error(
            `Unsupported Windows signing mode '${mode}'. Use 'pfx' or 'azure'.`
        );
    }

    return build;
}

module.exports = {
    SIGNING_MODES,
    createWindowsProductionConfig
};
