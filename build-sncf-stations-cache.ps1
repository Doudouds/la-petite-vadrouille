$queryLines = @(
  '[out:json][timeout:240];',
  'area(3602202162)->.fr;',
  '(',
  '  node["railway"~"^(station|halt)$"]["operator"~"SNCF|Gares & Connexions", i](area.fr);',
  '  node["railway"~"^(station|halt)$"]["network"~"SNCF", i](area.fr);',
  '  node["railway"~"^(station|halt)$"]["operator:wikidata"="Q22914"](area.fr);',
  '  node["railway"~"^(station|halt)$"]["uic_ref"](area.fr);',
  '  way["railway"~"^(station|halt)$"]["operator"~"SNCF|Gares & Connexions", i](area.fr);',
  '  way["railway"~"^(station|halt)$"]["network"~"SNCF", i](area.fr);',
  '  way["railway"~"^(station|halt)$"]["operator:wikidata"="Q22914"](area.fr);',
  '  way["railway"~"^(station|halt)$"]["uic_ref"](area.fr);',
  '  relation["railway"~"^(station|halt)$"]["operator"~"SNCF|Gares & Connexions", i](area.fr);',
  '  relation["railway"~"^(station|halt)$"]["network"~"SNCF", i](area.fr);',
  '  relation["railway"~"^(station|halt)$"]["operator:wikidata"="Q22914"](area.fr);',
  '  relation["railway"~"^(station|halt)$"]["uic_ref"](area.fr);',
  ');',
  'out center tags;'
)

$query = $queryLines -join "`n"
$endpoints = @(
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter'
)

$json = $null
$sourceUrl = $null
$tempJsonPath = Join-Path $PSScriptRoot 'stations-sncf.raw.json'

foreach ($url in $endpoints) {
  try {
    if (Test-Path $tempJsonPath) {
      Remove-Item $tempJsonPath -Force
    }

    curl.exe --ssl-no-revoke -sS $url --data-urlencode "data=$query" -o $tempJsonPath | Out-Null
    if (-not (Test-Path $tempJsonPath)) {
      continue
    }

    $raw = Get-Content $tempJsonPath -Raw -Encoding utf8
    if (-not $raw -or -not $raw.Trim().StartsWith('{')) {
      continue
    }

    $candidate = $raw | ConvertFrom-Json
    if (@($candidate.elements).Count -gt 0) {
      $json = $candidate
      $sourceUrl = $url
      break
    }
  } catch {
    continue
  }
}

if (Test-Path $tempJsonPath) {
  Remove-Item $tempJsonPath -Force
}

if (-not $json) {
  throw 'Unable to fetch SNCF station cache from Overpass.'
}

$stationsByKey = [ordered]@{}

foreach ($element in $json.elements) {
  $lat = $null
  $lon = $null

  if ($element.type -eq 'node' -and $null -ne $element.lat -and $null -ne $element.lon) {
    $lat = [double]$element.lat
    $lon = [double]$element.lon
  } elseif ($null -ne $element.center -and $null -ne $element.center.lat -and $null -ne $element.center.lon) {
    $lat = [double]$element.center.lat
    $lon = [double]$element.center.lon
  }

  $name = [string]$element.tags.name
  if ([string]::IsNullOrWhiteSpace($name) -or $null -eq $lat -or $null -eq $lon) {
    continue
  }

  $railway = [string]$element.tags.railway
  $stationType = [string]$element.tags.station
  $operator = [string]$element.tags.operator
  $network = [string]$element.tags.network
  $train = [string]$element.tags.train
  $uic = [string]$element.tags.uic_ref

  if ($stationType -match 'subway|light_rail|tram|monorail|funicular') {
    continue
  }

  $looksLikeNationalRail =
    $operator -match 'SNCF|Gares & Connexions' -or
    $network -match 'SNCF' -or
    $train -eq 'yes' -or
    -not [string]::IsNullOrWhiteSpace($uic)

  if (-not $looksLikeNationalRail) {
    continue
  }

  $key = if (-not [string]::IsNullOrWhiteSpace($uic)) {
    "uic:$uic"
  } else {
    "{0}:{1}:{2}" -f $name.ToLowerInvariant(), ([Math]::Round($lat, 5)), ([Math]::Round($lon, 5))
  }

  if (-not $stationsByKey.Contains($key)) {
    $stationsByKey[$key] = [ordered]@{
      name = $name
      lat = [Math]::Round($lat, 6)
      lon = [Math]::Round($lon, 6)
      uic = $uic
    }
  }
}

$stations = @($stationsByKey.Values | Sort-Object name)
$cache = [ordered]@{
  generatedAt = (Get-Date).ToString('s')
  source = $sourceUrl
  count = @($stations).Count
  stations = $stations
}

$targetPath = Join-Path $PSScriptRoot 'stations-sncf.js'
$js = 'window.SNCF_STATION_CACHE = ' + ($cache | ConvertTo-Json -Compress -Depth 5) + ';'
[System.IO.File]::WriteAllText($targetPath, $js, [System.Text.UTF8Encoding]::new($false))

[pscustomobject]@{
  source = $sourceUrl
  count = @($stations).Count
  file = $targetPath
  bytes = (Get-Item $targetPath).Length
} | Format-List