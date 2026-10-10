const fs = require('fs');
const path = require('path');
const product = require('../product-config');

function syncPackageJson(packagePath = path.join(__dirname, '..', 'package.json')) {
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    packageJson.name = product.packageName;
    packageJson.description = product.packageDescription;
    packageJson.scripts = packageJson.scripts || {};
    packageJson.scripts.release =
        'npm run product:sync && electron-builder --publish never';
    packageJson.build = packageJson.build || {};
    packageJson.build.files = packageJson.build.files || [];
    if (!packageJson.build.files.includes('product-config.js')) {
        packageJson.build.files.push('product-config.js');
    }
    packageJson.build.appId = product.appId;
    packageJson.build.productName = product.launcherName;
    packageJson.build.win = packageJson.build.win || {};
    packageJson.build.win.icon = product.iconFile;
    packageJson.build.mac = packageJson.build.mac || {};
    packageJson.build.mac.icon = product.iconFile;
    packageJson.build.dmg = packageJson.build.dmg || {};
    packageJson.build.dmg.icon = product.iconFile;
    packageJson.build.linux = packageJson.build.linux || {};
    packageJson.build.linux.icon = product.iconFile;
    packageJson.build.nsis = packageJson.build.nsis || {};
    packageJson.build.nsis.shortcutName = product.shortcutName;
    if (product.updateFilesBase) {
        packageJson.build.publish = {
            provider: 'generic',
            url: product.updateFilesBase
        };
    } else {
        delete packageJson.build.publish;
    }
    fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
    return packageJson;
}

if (require.main === module) {
    syncPackageJson();
}

module.exports = { syncPackageJson };
