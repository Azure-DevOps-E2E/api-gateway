param(
    [Parameter(Mandatory = $true)]
    [string]$BaseUrl,

    [ValidateRange(10, 1800)]
    [int]$TimeoutSeconds = 300,

    [ValidateRange(1, 60)]
    [int]$IntervalSeconds = 10
)

$ErrorActionPreference = "Stop"
$base = $BaseUrl.TrimEnd("/")
$checks = @(
    @{ Path = "/health/api-gateway"; Service = "api-gateway" },
    @{ Path = "/health/frontend"; Service = "frontend" },
    @{ Path = "/health/user-service"; Service = "user-service" },
    @{ Path = "/health/catalog-service"; Service = "catalog-service" },
    @{ Path = "/health/order-service"; Service = "order-service" }
)
$deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
$lastFailure = "No health request has completed yet"

do {
    $allHealthy = $true

    foreach ($check in $checks) {
        try {
            $response = Invoke-RestMethod -Uri "$base$($check.Path)" -TimeoutSec 5
            if ($response.status -ne "UP" -or $response.service -ne $check.Service) {
                $allHealthy = $false
                $lastFailure = "$($check.Service) returned an unexpected health response"
                break
            }
        }
        catch {
            $allHealthy = $false
            $lastFailure = "$($check.Service): $($_.Exception.Message)"
            break
        }
    }

    if ($allHealthy) {
        Write-Host "All components are healthy at $base" -ForegroundColor Green
        exit 0
    }

    if ([DateTimeOffset]::UtcNow -lt $deadline) {
        Write-Host "Waiting for health: $lastFailure"
        Start-Sleep -Seconds $IntervalSeconds
    }
}
while ([DateTimeOffset]::UtcNow -lt $deadline)

throw "Health check timed out after $TimeoutSeconds seconds. Last failure: $lastFailure"
