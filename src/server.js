'use strict';

const { createGateway } = require('./gateway');

function portFrom(env = process.env) {
  const value = Number(env.PORT || 8080);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return value;
}

const port = portFrom();
const server = createGateway();

server.listen(port, '0.0.0.0', () => {
  console.info(JSON.stringify({
    timestamp: new Date().toISOString(),
    message: 'api-gateway started',
    port,
    version: process.env.APP_VERSION || '1.0.0',
    imageTag: process.env.APP_IMAGE_TAG || process.env.APP_VERSION || '1.0.0'
  }));
});

function shutdown(signal) {
  console.info(JSON.stringify({
    timestamp: new Date().toISOString(),
    message: 'api-gateway stopping',
    signal
  }));
  server.close((error) => {
    process.exitCode = error ? 1 : 0;
  });
  setTimeout(() => {
    server.closeAllConnections();
    process.exitCode = 1;
  }, 10_000).unref();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

module.exports = { portFrom };
