/** @type {import('jest').Config} */
module.exports = {
    // Use a longer timeout at the root level
    testTimeout: 30000,

    // Force all I/O operations to drain before exit
    testEnvironment: 'node',

    // Increase worker idle memory limit to prevent premature cleanup
    workerIdleMemoryLimit: '512MB',

    // Run in sequence within a single worker to avoid race conditions
    maxWorkers: 1,

    // Wait for async resources to complete
    fakeTimers: {
        enableGlobally: false
    }
};
