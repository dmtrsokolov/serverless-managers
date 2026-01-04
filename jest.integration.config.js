const config = require('./jest.config');

module.exports = {
    ...config,
    testPathIgnorePatterns: ['/node_modules/'],
    testMatch: ['<rootDir>/test/integration/**/*.test.js'],
    // Ensure we have enough time for integration tests
    testTimeout: 60000,
};
