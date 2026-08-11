# API Gateway

API Gateway là public entry point của hệ thống. Service được viết bằng Node.js
24 với HTTP module có sẵn, không có runtime dependency và không dùng NGINX cho
logic routing.

## Responsibilities

- Trả frontend cho `/` và các non-API path.
- Route User, Catalog và Order API theo path.
- Giữ browser trên một origin bằng relative URL `/api/v1/...`.
- Tạo hoặc truyền tiếp `X-Request-ID`.
- Áp dụng upstream timeout, giới hạn request body 1 MiB và chuẩn hóa lỗi gateway.
- Phục vụ dashboard health và proxy health của từng component.

## Routes

| Public path | Upstream/path |
|---|---|
| `/` và non-API path | `FRONTEND_URL` |
| `/api/v1/users...` | `USER_SERVICE_URL` |
| `/api/v1/products...` | `CATALOG_SERVICE_URL` |
| `/api/v1/orders...` | `ORDER_SERVICE_URL` |
| `/health` | Dashboard tích hợp trong gateway |
| `/gateway-health` | Gateway liveness JSON |
| `/health/api-gateway` | Gateway health JSON |
| `/health/frontend` | Frontend `/health` |
| `/health/user-service` | User Service `/health` |
| `/health/catalog-service` | Catalog Service `/health` |
| `/health/order-service` | Order Service `/health` |

Unknown `/api/...` trả `404 ROUTE_NOT_FOUND`; upstream không kết nối được trả
`502 UPSTREAM_UNAVAILABLE`; upstream timeout trả `504 UPSTREAM_TIMEOUT`.

## Run locally

Yêu cầu Node.js 24. Khi chạy native, trỏ gateway tới bốn service đang chạy trên
máy local:

```powershell
$env:PORT = "8080"
$env:APP_VERSION = "local"
$env:FRONTEND_URL = "http://localhost:5173"
$env:USER_SERVICE_URL = "http://localhost:8081"
$env:CATALOG_SERVICE_URL = "http://localhost:8000"
$env:ORDER_SERVICE_URL = "http://localhost:8083"
npm ci
npm start
```

Gateway self-health vẫn hoạt động nếu upstream chưa chạy; route tương ứng sẽ trả
health `DOWN` hoặc lỗi gateway có `requestId`.

Để chạy đủ hệ thống bằng container, đặt repository này cạnh `frontend`,
`user-service`, `catalog-service`, `order-service`, `devops`, rồi chạy Compose từ
repo `devops`.

## Test

```powershell
npm ci
npm test
npm run check
```

Bộ test dùng các HTTP upstream tạm trên random port để kiểm tra route, query,
request body, request ID, health proxy, frontend fallback, 404, 502 và payload
limit mà không cần khởi động các service khác.

## Docker

```powershell
docker build -t api-gateway:local .
```

Container chạy non-root trên cổng `8080` và có healthcheck tại
`/gateway-health`.

## Configuration

| Variable | Default |
|---|---|
| `PORT` | `8080` |
| `APP_VERSION` | `1.0.0` |
| `FRONTEND_URL` | `http://frontend:80` |
| `USER_SERVICE_URL` | `http://user-service:8081` |
| `CATALOG_SERVICE_URL` | `http://catalog-service:8000` |
| `ORDER_SERVICE_URL` | `http://order-service:8083` |
| `REQUEST_TIMEOUT_MS` | `10000` |
| `HEALTH_TIMEOUT_MS` | `4000` |
| `MAX_BODY_BYTES` | `1048576` |

## CI/CD

`azure-pipelines.yml` reuse
`devops/pipelines/templates/service-pipeline.yml`. Pipeline chạy test, Docker
build và Trivy trên mọi branch; branch `main` tiếp tục push ACR, deploy DEV,
health/smoke, approval rồi deploy PROD. Helm chart của service nằm trong
`devops/deploy/helm/api-gateway`.

## Project structure

```text
api-gateway/
├── public/health.html
├── src/
│   ├── gateway.js
│   └── server.js
├── test/gateway.test.js
├── azure-pipelines.yml
├── Dockerfile
├── package.json
└── package-lock.json
```
