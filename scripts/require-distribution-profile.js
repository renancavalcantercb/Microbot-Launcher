const { requireDistributionProfile } = require('../libs/distribution-build');

// electron-builder `beforePack` hook (package.json build.beforePack).
module.exports = requireDistributionProfile;
