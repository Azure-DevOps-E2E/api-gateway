# API Contract

All public endpoints are available through the gateway at `http://localhost:8080/api/v1`. Payload fields use `camelCase`, timestamps use ISO 8601 UTC, and VND amounts are integers.

## Common error

```json
{
  "error": {
    "code": "PRODUCT_NOT_FOUND",
    "message": "Product prd-999 does not exist",
    "requestId": "2f159fc0f3b84ced"
  }
}
```

## Users

### `GET /api/v1/users`

Returns `{ "items": User[] }`.

### `GET /api/v1/users/{id}`

Returns one user or `404 USER_NOT_FOUND`.

```json
{
  "id": "usr-001",
  "name": "Nguyen Van An",
  "email": "an@example.com"
}
```

## Products

### `GET /api/v1/products`

Returns `{ "items": Product[] }`.

### `GET /api/v1/products/{id}`

Returns one product or `404 PRODUCT_NOT_FOUND`.

```json
{
  "id": "prd-001",
  "name": "Mechanical Keyboard",
  "description": "Compact 75% layout with tactile switches.",
  "price": 1290000,
  "currency": "VND",
  "stock": 10,
  "accent": "amber"
}
```

## Orders

### `GET /api/v1/orders`

Returns `{ "items": Order[] }`, newest first.

### `GET /api/v1/orders/{id}`

Returns one order or `404 ORDER_NOT_FOUND`.

### `POST /api/v1/orders`

```json
{
  "userId": "usr-001",
  "items": [
    {
      "productId": "prd-001",
      "quantity": 2
    }
  ]
}
```

Returns `201 Created` with a server-calculated product snapshot:

```json
{
  "id": "ord-001",
  "userId": "usr-001",
  "items": [
    {
      "productId": "prd-001",
      "productName": "Mechanical Keyboard",
      "unitPrice": 1290000,
      "quantity": 2,
      "lineTotal": 2580000
    }
  ],
  "totalAmount": 2580000,
  "currency": "VND",
  "status": "CREATED",
  "createdAt": "2026-08-11T08:30:00Z"
}
```

Possible create-order errors:

| Status | Code | Meaning |
|---:|---|---|
| `422` | `VALIDATION_ERROR` | Missing or malformed fields |
| `422` | `DUPLICATE_PRODUCT` | Product appears more than once |
| `422` | `USER_NOT_FOUND` | Referenced user does not exist |
| `422` | `PRODUCT_NOT_FOUND` | Referenced product does not exist |
| `409` | `INSUFFICIENT_STOCK` | Quantity is above current stock |
| `503` | `USER_SERVICE_UNAVAILABLE` | User Service cannot be reached |
| `503` | `CATALOG_SERVICE_UNAVAILABLE` | Catalog Service cannot be reached |

## Health endpoints

Backend health endpoints are private to the Compose network. The public gateway health endpoint is `GET /gateway-health`.
