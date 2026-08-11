param(
    [string]$BaseUrl = "http://localhost:8080"
)

$ErrorActionPreference = "Stop"

function Assert-True {
    param(
        [bool]$Condition,
        [string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

Write-Host "Checking service health and versions..."
$healthChecks = @(
    @{ Path = "/health/api-gateway"; Service = "api-gateway" },
    @{ Path = "/health/frontend"; Service = "frontend" },
    @{ Path = "/health/user-service"; Service = "user-service" },
    @{ Path = "/health/catalog-service"; Service = "catalog-service" },
    @{ Path = "/health/order-service"; Service = "order-service" }
)

foreach ($check in $healthChecks) {
    $health = Invoke-RestMethod -Uri "$BaseUrl$($check.Path)"
    Assert-True ($health.status -eq "UP") "$($check.Service) is not healthy"
    Assert-True ($health.service -eq $check.Service) "$($check.Service) returned an unexpected service name"
    Assert-True (-not [string]::IsNullOrWhiteSpace($health.version)) "$($check.Service) did not report a version"
}

Write-Host "Reading users and products through the gateway..."
$users = Invoke-RestMethod -Uri "$BaseUrl/api/v1/users"
$products = Invoke-RestMethod -Uri "$BaseUrl/api/v1/products"
Assert-True ($users.items.Count -gt 0) "User seed data is missing"
Assert-True ($products.items.Count -gt 0) "Product seed data is missing"

$payload = @{
    userId = $users.items[0].id
    items  = @(
        @{
            productId = $products.items[0].id
            quantity  = 2
        }
    )
} | ConvertTo-Json -Depth 4

Write-Host "Creating an order..."
$order = Invoke-RestMethod `
    -Method Post `
    -Uri "$BaseUrl/api/v1/orders" `
    -ContentType "application/json" `
    -Body $payload

Assert-True ($order.id -like "ord-*") "Order ID has an unexpected format"
Assert-True ($order.totalAmount -gt 0) "Order total was not calculated"

Write-Host "Reading the created order..."
$savedOrder = Invoke-RestMethod -Uri "$BaseUrl/api/v1/orders/$($order.id)"
Assert-True ($savedOrder.id -eq $order.id) "Created order cannot be read back"

Write-Host "Smoke test passed: $($order.id), total $($order.totalAmount) VND" -ForegroundColor Green
