param(
    [string]$ReleaseConfigPath = (Join-Path $PSScriptRoot '..\config\release-updates.production.json')
)

$ErrorActionPreference = 'Stop'
$launcherRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$env:MICROBOT_CUT_API_BASE_URL = 'https://cut.xulixnacc.online/api/v1'

# Production plugins remain disabled until an independently signed production
# catalog and artifact repository are published.
Remove-Item Env:MICROBOT_CUT_PLUGIN_DEV -ErrorAction SilentlyContinue
$env:MICROBOT_CUT_PLUGIN_REPOSITORY_ENABLED = 'false'
foreach ($name in @(
    'MICROBOT_CUT_PLUGIN_MANIFEST_URL',
    'MICROBOT_CUT_PLUGIN_RELEASES_URL',
    'MICROBOT_CUT_PLUGIN_RELEASES_API_URL',
    'MICROBOT_CUT_PLUGIN_PUBLIC_KEY',
    'MICROBOT_CUT_PLUGIN_PUBLIC_KEY_ID',
    'MICROBOT_CUT_RELEASE_UPDATES_ENABLED',
    'MICROBOT_CUT_RELEASE_CHANNEL',
    'MICROBOT_CUT_RELEASE_MANIFEST_URL',
    'MICROBOT_CUT_RELEASE_ARTIFACT_BASE_URL',
    'MICROBOT_CUT_RELEASE_PUBLIC_KEY',
    'MICROBOT_CUT_RELEASE_PUBLIC_KEY_ID',
    'MICROBOT_CUT_RELEASE_CHANNELS'
)) {
    Remove-Item "Env:$name" -ErrorAction SilentlyContinue
}

$resolvedReleaseConfig = (Resolve-Path -LiteralPath $ReleaseConfigPath).Path
$release = Get-Content -Raw -LiteralPath $resolvedReleaseConfig | ConvertFrom-Json
if ($release.enabled -ne $true) {
    throw 'Production signed release updates must be enabled.'
}
if ($release.defaultChannel -ne 'production') {
    throw 'The production launcher must default to the production release channel.'
}

$channelSettings = [ordered]@{}
foreach ($channel in @('staging', 'production')) {
    $channelConfig = $release.channels.$channel
    if ($null -eq $channelConfig) {
        throw "Release config is missing channel: $channel"
    }
    foreach ($property in @('manifestUrl', 'artifactBaseUrl', 'publicKeyFile')) {
        if ([string]::IsNullOrWhiteSpace([string]$channelConfig.$property)) {
            throw "Release channel $channel is missing: $property"
        }
    }
    foreach ($urlValue in @($channelConfig.manifestUrl, $channelConfig.artifactBaseUrl)) {
        $uri = [Uri]$urlValue
        if ($uri.Scheme -ne 'https' -or -not [string]::IsNullOrEmpty($uri.UserInfo)) {
            throw "Release URL must use HTTPS without credentials: $urlValue"
        }
    }
    $publicMetadataPath = Join-Path (Split-Path $resolvedReleaseConfig) $channelConfig.publicKeyFile
    $publicMetadata = Get-Content -Raw -LiteralPath $publicMetadataPath | ConvertFrom-Json
    foreach ($property in @('keyId', 'publicKey')) {
        if ([string]::IsNullOrWhiteSpace([string]$publicMetadata.$property)) {
            throw "Release channel $channel public key metadata is missing: $property"
        }
    }
    $channelSettings[$channel] = [ordered]@{
        manifestUrl = $channelConfig.manifestUrl
        artifactBaseUrl = $channelConfig.artifactBaseUrl
        publicKey = $publicMetadata.publicKey
        publicKeyId = $publicMetadata.keyId
    }
}

$env:MICROBOT_CUT_RELEASE_UPDATES_ENABLED = 'true'
$env:MICROBOT_CUT_RELEASE_CHANNEL = $release.defaultChannel
$env:MICROBOT_CUT_RELEASE_CHANNELS = $channelSettings | ConvertTo-Json -Compress -Depth 4

Push-Location $launcherRoot
try {
    & npm.cmd run dev
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
