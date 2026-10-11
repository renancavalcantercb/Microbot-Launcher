const packageJson = require('./package.json');
const {
    createWindowsProductionConfig
} = require('./libs/windows-signing-config');

module.exports = createWindowsProductionConfig(packageJson.build, process.env);
