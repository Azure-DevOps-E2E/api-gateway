'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { after, before, test } = require('node:test');

const { createGateway, selectRoute } = require('../src/gateway');

const servers = [];

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      servers.push(server);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function jsonResponse(response, payload, statusCode = 200) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json'
  });
  response.end(body);
}

let gatewayUrl;
let unavailableUrl;

before(async () => {
  const frontendUrl = await listen(http.createServer((request, response) => {
    if (request.url === '/health') {
      jsonResponse(response, { status: 'UP', service: 'frontend', version: 'web-test' });
      return;
    }
    response.end(`frontend:${request.url}`);
  }));

  const userUrl = await listen(http.createServer((request, response) => {
    if (request.url === '/health') {
      jsonResponse(response, { status: 'UP', service: 'user-service', version: 'user-test' });
      return;
    }
    jsonResponse(response, {
      service: 'user-service',
      method: request.method,
      url: request.url,
      requestId: request.headers['x-request-id']
    });
  }));

  const catalogUrl = await listen(http.createServer((request, response) => {
    if (request.url === '/health') {
      jsonResponse(response, { status: 'UP', service: 'catalog-service', version: 'catalog-test' });
      return;
    }
    jsonResponse(response, { service: 'catalog-service', url: request.url });
  }));

  const orderUrl = await listen(http.createServer((request, response) => {
    if (request.url === '/health') {
      jsonResponse(response, { status: 'UP', service: 'order-service', version: 'order-test' });
      return;
    }
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      jsonResponse(response, {
        service: 'order-service',
        method: request.method,
        body: Buffer.concat(chunks).toString('utf8')
      }, 201);
    });
  }));

  const closedServer = http.createServer();
  unavailableUrl = await listen(closedServer);
  await close(closedServer);
  servers.splice(servers.indexOf(closedServer), 1);

  const gateway = createGateway({
    config: {
      version: 'gateway-test',
      targets: {
        frontend: frontendUrl,
        user: userUrl,
        catalog: catalogUrl,
        order: orderUrl
      }
    },
    healthPage: Buffer.from('<!doctype html><title>Health</title>'),
    logger: { info() {} }
  });
  gatewayUrl = await listen(gateway);
});

after(async () => {
  await Promise.all(servers.reverse().map(close));
});

test('routes only complete API path segments', () => {
  assert.equal(selectRoute('/liveness').kind, 'liveness');
  assert.equal(selectRoute('/api/v1/users').target, 'user');
  assert.equal(selectRoute('/api/v1/users/42').target, 'user');
  assert.equal(selectRoute('/api/v1/users-extra').kind, 'missing-api');
  assert.equal(selectRoute('/api/v1/system/versions').kind, 'versions');
  assert.equal(selectRoute('/store').target, 'frontend');
});

test('reports process liveness without checking downstream services', async () => {
  const response = await fetch(gatewayUrl + '/liveness');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('x-request-id'), /^[A-Za-z0-9._:-]+$/);
  assert.deepEqual(await response.json(), {
    status: 'UP',
    service: 'api-gateway'
  });
});

test('reports gateway health and runtime version', async () => {
  const response = await fetch(`${gatewayUrl}/health/api-gateway`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('x-request-id'), /^[A-Za-z0-9._:-]+$/);
  assert.deepEqual(await response.json(), {
    status: 'UP',
    service: 'api-gateway',
    version: 'gateway-test',
    imageTag: 'gateway-test'
  });
});

test('preserves URL and propagates a valid request ID to user-service', async () => {
  const response = await fetch(`${gatewayUrl}/api/v1/users/42?expand=roles`, {
    headers: { 'x-request-id': 'test-request-42' }
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-request-id'), 'test-request-42');
  assert.deepEqual(await response.json(), {
    service: 'user-service',
    method: 'GET',
    url: '/api/v1/users/42?expand=roles',
    requestId: 'test-request-42'
  });
});

test('forwards a POST body to order-service', async () => {
  const body = JSON.stringify({ userId: 'u-1', productId: 'p-1' });
  const response = await fetch(`${gatewayUrl}/api/v1/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    service: 'order-service',
    method: 'POST',
    body
  });
});

test('proxies component health through a stable gateway URL', async () => {
  const response = await fetch(`${gatewayUrl}/health/frontend`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: 'UP',
    service: 'frontend',
    version: 'web-test'
  });
});
test('reports consolidated service versions and image tags', async () => {
  const response = await fetch(`${gatewayUrl}/api/v1/system/versions`);
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.status, 'UP');
  assert.equal(body.service, 'api-gateway');
  assert.equal(body.version, 'gateway-test');
  assert.equal(body.imageTag, 'gateway-test');
  assert.match(body.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(body.services, [
    { service: 'frontend', status: 'UP', version: 'web-test', imageTag: 'web-test' },
    { service: 'user-service', status: 'UP', version: 'user-test', imageTag: 'user-test' },
    { service: 'catalog-service', status: 'UP', version: 'catalog-test', imageTag: 'catalog-test' },
    { service: 'order-service', status: 'UP', version: 'order-test', imageTag: 'order-test' }
  ]);
});

test('returns a common JSON error for unknown API routes', async () => {
  const response = await fetch(`${gatewayUrl}/api/v1/not-a-service`);
  const body = await response.json();
  assert.equal(response.status, 404);
  assert.equal(body.error.code, 'ROUTE_NOT_FOUND');
  assert.equal(body.error.requestId, response.headers.get('x-request-id'));
});

test('sends non-API routes to the frontend', async () => {
  const response = await fetch(`${gatewayUrl}/products/sku-1`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'frontend:/products/sku-1');
});

test('returns 502 when an application upstream is unavailable', async () => {
  const gateway = createGateway({
    config: { targets: { user: unavailableUrl } },
    healthPage: Buffer.from('health'),
    logger: { info() {} }
  });
  const isolatedGatewayUrl = await listen(gateway);
  const response = await fetch(`${isolatedGatewayUrl}/api/v1/users`);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'UPSTREAM_UNAVAILABLE');
  await close(gateway);
  servers.splice(servers.indexOf(gateway), 1);
});

test('rejects declared request bodies larger than the configured limit', async () => {
  const gateway = createGateway({
    config: { maxBodyBytes: 4 },
    healthPage: Buffer.from('health'),
    logger: { info() {} }
  });
  const isolatedGatewayUrl = await listen(gateway);
  const response = await fetch(`${isolatedGatewayUrl}/api/v1/orders`, {
    method: 'POST',
    body: '12345'
  });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, 'PAYLOAD_TOO_LARGE');
  await close(gateway);
  servers.splice(servers.indexOf(gateway), 1);
});
