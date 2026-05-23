param(
    [string]$LogoPath = (Join-Path (Split-Path $PSScriptRoot -Parent) 'logo.png'),
    [string]$AndroidResDir = (Join-Path (Split-Path $PSScriptRoot -Parent) 'android\app\src\main\res'),
    [string]$PlayStoreDir = (Join-Path (Split-Path $PSScriptRoot -Parent) 'play-store\assets')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

if (-not (Test-Path $LogoPath)) {
    throw "Logo file not found: $LogoPath"
}

if (-not (Test-Path $AndroidResDir)) {
    throw "Android resources directory not found: $AndroidResDir"
}

New-Item -ItemType Directory -Force -Path $PlayStoreDir | Out-Null

$backgroundColor = [System.Drawing.ColorTranslator]::FromHtml('#F5F7F5')
$accentColor = [System.Drawing.ColorTranslator]::FromHtml('#1B5E20')
$accentColorSoft = [System.Drawing.ColorTranslator]::FromHtml('#2E7D32')
$logo = [System.Drawing.Image]::FromFile($LogoPath)

function New-Bitmap {
    param(
        [int]$Width,
        [int]$Height,
        [System.Drawing.Color]$FillColor,
        [bool]$Transparent = $false
    )

    $bitmap = New-Object System.Drawing.Bitmap $Width, $Height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

    if ($Transparent) {
        $graphics.Clear([System.Drawing.Color]::FromArgb(0, 0, 0, 0))
    } else {
        $graphics.Clear($FillColor)
    }

    return [pscustomobject]@{
        Bitmap = $bitmap
        Graphics = $graphics
    }
}

function Save-Png {
    param(
        [System.Drawing.Bitmap]$Bitmap,
        [string]$Path
    )

    $directory = Split-Path $Path -Parent
    if ($directory) {
        New-Item -ItemType Directory -Force -Path $directory | Out-Null
    }
    $Bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
}

function Draw-Logo {
    param(
        [System.Drawing.Graphics]$Graphics,
        [int]$CanvasWidth,
        [int]$CanvasHeight,
        [double]$Scale,
        [bool]$Transparent = $false,
        [int]$OffsetX = 0,
        [int]$OffsetY = 0
    )

    $targetWidth = [int]([Math]::Round($CanvasWidth * $Scale))
    $targetHeight = [int]([Math]::Round($CanvasHeight * $Scale))
    $x = $OffsetX + [int]([Math]::Round(($CanvasWidth - $targetWidth) / 2))
    $y = $OffsetY + [int]([Math]::Round(($CanvasHeight - $targetHeight) / 2))
    $rect = New-Object System.Drawing.Rectangle $x, $y, $targetWidth, $targetHeight
    $Graphics.DrawImage($logo, $rect)
}

function Write-LauncherIcons {
    $legacyTargets = @{
        'mipmap-mdpi' = 48
        'mipmap-hdpi' = 72
        'mipmap-xhdpi' = 96
        'mipmap-xxhdpi' = 144
        'mipmap-xxxhdpi' = 192
    }
    $adaptiveTargets = @{
        'mipmap-mdpi' = 108
        'mipmap-hdpi' = 162
        'mipmap-xhdpi' = 216
        'mipmap-xxhdpi' = 324
        'mipmap-xxxhdpi' = 432
    }

    foreach ($folder in $legacyTargets.Keys) {
        $size = $legacyTargets[$folder]
        $surface = New-Bitmap -Width $size -Height $size -FillColor $backgroundColor
        try {
            Draw-Logo -Graphics $surface.Graphics -CanvasWidth $size -CanvasHeight $size -Scale 0.84
            Save-Png -Bitmap $surface.Bitmap -Path (Join-Path $AndroidResDir "$folder\ic_launcher.png")
            Save-Png -Bitmap $surface.Bitmap -Path (Join-Path $AndroidResDir "$folder\ic_launcher_round.png")
        } finally {
            $surface.Graphics.Dispose()
            $surface.Bitmap.Dispose()
        }
    }

    foreach ($folder in $adaptiveTargets.Keys) {
        $size = $adaptiveTargets[$folder]
        $surface = New-Bitmap -Width $size -Height $size -FillColor $backgroundColor -Transparent $true
        try {
            Draw-Logo -Graphics $surface.Graphics -CanvasWidth $size -CanvasHeight $size -Scale 0.68 -Transparent $true
            Save-Png -Bitmap $surface.Bitmap -Path (Join-Path $AndroidResDir "$folder\ic_launcher_foreground.png")
        } finally {
            $surface.Graphics.Dispose()
            $surface.Bitmap.Dispose()
        }
    }
}

function Write-SplashAssets {
    Get-ChildItem -Path $AndroidResDir -Filter splash.png -Recurse | ForEach-Object {
        $existing = [System.Drawing.Image]::FromFile($_.FullName)
        $width = $existing.Width
        $height = $existing.Height
        $existing.Dispose()

        $surface = New-Bitmap -Width $width -Height $height -FillColor $backgroundColor
        try {
            $scale = if ($width -ge $height) { 0.22 } else { 0.28 }
            Draw-Logo -Graphics $surface.Graphics -CanvasWidth $width -CanvasHeight $height -Scale $scale
            Save-Png -Bitmap $surface.Bitmap -Path $_.FullName
        } finally {
            $surface.Graphics.Dispose()
            $surface.Bitmap.Dispose()
        }
    }
}

function Write-PlayStoreAssets {
    $iconSurface = New-Bitmap -Width 512 -Height 512 -FillColor $backgroundColor
    try {
        Draw-Logo -Graphics $iconSurface.Graphics -CanvasWidth 512 -CanvasHeight 512 -Scale 0.84
        Save-Png -Bitmap $iconSurface.Bitmap -Path (Join-Path $PlayStoreDir 'icon-512.png')
    } finally {
        $iconSurface.Graphics.Dispose()
        $iconSurface.Bitmap.Dispose()
    }

    $bannerSurface = New-Bitmap -Width 1024 -Height 500 -FillColor $backgroundColor
    try {
        $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
            (New-Object System.Drawing.Point 0, 0),
            (New-Object System.Drawing.Point 1024, 500),
            $backgroundColor,
            $accentColorSoft
        )
        try {
            $bannerSurface.Graphics.FillRectangle($brush, 0, 0, 1024, 500)
        } finally {
            $brush.Dispose()
        }

        $overlayBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(170, 255, 255, 255))
        try {
            $bannerSurface.Graphics.FillRectangle($overlayBrush, 48, 48, 600, 404)
        } finally {
            $overlayBrush.Dispose()
        }

        $titleFont = New-Object System.Drawing.Font('Segoe UI', 38, [System.Drawing.FontStyle]::Bold)
        $subtitleFont = New-Object System.Drawing.Font('Segoe UI', 20, [System.Drawing.FontStyle]::Regular)
        $titleBrush = New-Object System.Drawing.SolidBrush($accentColor)
        $subtitleBrush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#36522E'))
        try {
            $bannerSurface.Graphics.DrawString('Tracé GR', $titleFont, $titleBrush, 88, 126)
            $bannerSurface.Graphics.DrawString('Les GR de France sur Android', $subtitleFont, $subtitleBrush, 92, 198)
            $bannerSurface.Graphics.DrawString('Carte, catalogue et etapes', $subtitleFont, $subtitleBrush, 92, 238)
            $bannerSurface.Graphics.DrawString('Cache local pour les traces deja ouvertes', $subtitleFont, $subtitleBrush, 92, 278)
        } finally {
            $titleFont.Dispose()
            $subtitleFont.Dispose()
            $titleBrush.Dispose()
            $subtitleBrush.Dispose()
        }

        Draw-Logo -Graphics $bannerSurface.Graphics -CanvasWidth 300 -CanvasHeight 300 -Scale 0.82 -OffsetX 682 -OffsetY 100
        Save-Png -Bitmap $bannerSurface.Bitmap -Path (Join-Path $PlayStoreDir 'feature-graphic.png')
    } finally {
        $bannerSurface.Graphics.Dispose()
        $bannerSurface.Bitmap.Dispose()
    }
}

try {
    Write-LauncherIcons
    Write-SplashAssets
    Write-PlayStoreAssets
    Write-Output 'Android branding assets generated.'
} finally {
    $logo.Dispose()
}