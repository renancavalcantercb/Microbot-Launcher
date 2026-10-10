param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot '..\config\plugin-repository.staging.json'),
    [string]$ReleaseConfigPath = (Join-Path $PSScriptRoot '..\config\release-updates.staging.json')
)

$ErrorActionPreference = 'Stop'
$launcherRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$resolvedConfig = (Resolve-Path -LiteralPath $ConfigPath).Path
$repository = Get-Content -Raw -LiteralPath $resolvedConfig | ConvertFrom-Json

foreach ($property in @('productApiBaseUrl', 'manifestUrl', 'releasesUrl', 'publicKey', 'publicKeyId')) {
    if ([string]::IsNullOrWhiteSpace([string]$repository.$property)) {
        throw "Staging repository config is missing: $property"
    }
}

foreach ($urlValue in @($repository.productApiBaseUrl, $repository.manifestUrl, $repository.releasesUrl)) {
    $uri = [Uri]$urlValue
    if ($uri.Scheme -ne 'https' -or -not [string]::IsNullOrEmpty($uri.UserInfo)) {
        throw "Staging repository URL must use HTTPS without credentials: $urlValue"
    }
}

Remove-Item Env:MICROBOT_CUT_PLUGIN_DEV -ErrorAction SilentlyContinue
$env:MICROBOT_CUT_API_BASE_URL = $repository.productApiBaseUrl
$env:MICROBOT_CUT_PLUGIN_REPOSITORY_ENABLED = 'true'
$env:MICROBOT_CUT_PLUGIN_MANIFEST_URL = $repository.manifestUrl
$env:MICROBOT_CUT_PLUGIN_RELEASES_URL = $repository.releasesUrl
$env:MICROBOT_CUT_PLUGIN_PUBLIC_KEY = $repository.publicKey
$env:MICROBOT_CUT_PLUGIN_PUBLIC_KEY_ID = $repository.publicKeyId

foreach ($name in @(
    'MICROBOT_CUT_RELEASE_UPDATES_ENABLED',
    'MICROBOT_CUT_RELEASE_CHANNEL',
    'MICROBOT_CUT_RELEASE_MANIFEST_URL',
    'MICROBOT_CUT_RELEASE_ARTIFACT_BASE_URL',
    'MICROBOT_CUT_RELEASE_PUBLIC_KEY',
    'MICROBOT_CUT_RELEASE_PUBLIC_KEY_ID'
)) {
    Remove-Item "Env:$name" -ErrorAction SilentlyContinue
}

if (Test-Path -LiteralPath $ReleaseConfigPath) {
    $resolvedReleaseConfig = (Resolve-Path -LiteralPath $ReleaseConfigPath).Path
    $release = Get-Content -Raw -LiteralPath $resolvedReleaseConfig | ConvertFrom-Json
    if ($release.enabled -eq $true) {
        foreach ($property in @('channel', 'manifestUrl', 'artifactBaseUrl', 'publicKeyFile')) {
            if ([string]::IsNullOrWhiteSpace([string]$release.$property)) {
                throw "Staging release config is missing: $property"
            }
        }
        if ($release.channel -ne 'staging') {
            throw 'The development launcher may only use the staging release channel.'
        }
        foreach ($urlValue in @($release.manifestUrl, $release.artifactBaseUrl)) {
            $uri = [Uri]$urlValue
            if ($uri.Scheme -ne 'https' -or -not [string]::IsNullOrEmpty($uri.UserInfo)) {
                throw "Staging release URL must use HTTPS without credentials: $urlValue"
            }
        }
        $publicMetadataPath = Join-Path (Split-Path $resolvedReleaseConfig) $release.publicKeyFile
        $publicMetadata = Get-Content -Raw -LiteralPath $publicMetadataPath | ConvertFrom-Json
        foreach ($property in @('keyId', 'publicKey')) {
            if ([string]::IsNullOrWhiteSpace([string]$publicMetadata.$property)) {
                throw "Staging release public key metadata is missing: $property"
            }
        }
        $env:MICROBOT_CUT_RELEASE_UPDATES_ENABLED = 'true'
        $env:MICROBOT_CUT_RELEASE_CHANNEL = $release.channel
        $env:MICROBOT_CUT_RELEASE_MANIFEST_URL = $release.manifestUrl
        $env:MICROBOT_CUT_RELEASE_ARTIFACT_BASE_URL = $release.artifactBaseUrl
        $env:MICROBOT_CUT_RELEASE_PUBLIC_KEY = $publicMetadata.publicKey
        $env:MICROBOT_CUT_RELEASE_PUBLIC_KEY_ID = $publicMetadata.keyId
    }
}

Push-Location $launcherRoot
try {
    & npm.cmd run dev
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
