param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot '..\config\plugin-repository.staging.json'),
    [string]$ReleaseConfigPath = (Join-Path $PSScriptRoot '..\config\release-updates.staging.json'),
    [switch]$PluginDevelopment,
    [string]$PluginJar = (Join-Path $PSScriptRoot '..\..\microbot-cut-plugins\plugins\cut-walker\build\libs\cut-walker-0.1.0.jar')
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

$env:MICROBOT_CUT_API_BASE_URL = $repository.productApiBaseUrl

if ($PluginDevelopment) {
    $resolvedPluginJar = (Resolve-Path -LiteralPath $PluginJar).Path
    $developmentPluginDirectory = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.runelite\microbot-cut-dev-plugins'
    $developmentPluginJar = Join-Path $developmentPluginDirectory 'CutWalkerPlugin.jar'

    New-Item -ItemType Directory -Force -Path $developmentPluginDirectory | Out-Null
    Copy-Item -Force -LiteralPath $resolvedPluginJar -Destination $developmentPluginJar

    $env:MICROBOT_CUT_PLUGIN_DEV = 'true'
    $env:MICROBOT_CUT_PLUGIN_REPOSITORY_ENABLED = 'false'
    foreach ($name in @(
        'MICROBOT_CUT_PLUGIN_MANIFEST_URL',
        'MICROBOT_CUT_PLUGIN_RELEASES_URL',
        'MICROBOT_CUT_PLUGIN_PUBLIC_KEY',
        'MICROBOT_CUT_PLUGIN_PUBLIC_KEY_ID'
    )) {
        Remove-Item "Env:$name" -ErrorAction SilentlyContinue
    }
    Write-Host "Installed local Cut Walker development artifact: $developmentPluginJar"
} else {
    Remove-Item Env:MICROBOT_CUT_PLUGIN_DEV -ErrorAction SilentlyContinue
    $env:MICROBOT_CUT_PLUGIN_REPOSITORY_ENABLED = 'true'
    $env:MICROBOT_CUT_PLUGIN_MANIFEST_URL = $repository.manifestUrl
    $env:MICROBOT_CUT_PLUGIN_RELEASES_URL = $repository.releasesUrl
    $env:MICROBOT_CUT_PLUGIN_PUBLIC_KEY = $repository.publicKey
    $env:MICROBOT_CUT_PLUGIN_PUBLIC_KEY_ID = $repository.publicKeyId
}

foreach ($name in @(
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

if (Test-Path -LiteralPath $ReleaseConfigPath) {
    $resolvedReleaseConfig = (Resolve-Path -LiteralPath $ReleaseConfigPath).Path
    $release = Get-Content -Raw -LiteralPath $resolvedReleaseConfig | ConvertFrom-Json
    if ($release.enabled -eq $true) {
        foreach ($property in @('defaultChannel', 'channels')) {
            if ([string]::IsNullOrWhiteSpace([string]$release.$property)) {
                throw "Staging release config is missing: $property"
            }
        }
        if ($release.defaultChannel -ne 'staging') {
            throw 'The development launcher must default to the staging release channel.'
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
    }
}

Push-Location $launcherRoot
try {
    & npm.cmd run dev
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
