const path = require('path');
const http = require('http');
const { ProcessManager, WorkerManager } = require('../../lib');

// robust request helper
const makeRequest = (port) => {
    return new Promise((resolve, reject) => {
        const req = http.get(`http://localhost:${port}/`, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => resolve(data));
        });
        req.on('error', reject);
    });
};

const scriptDirPath = path.join(__dirname, '../../examples/scripts');
const scriptFiles = ['index.js', 'greet.js'];
const managerConfig = { scriptDirPath, scriptFiles };

describe('System Integration Tests', () => {
    // Increase timeout for integration tests
    jest.setTimeout(30000);

    describe('ProcessManager Integration', () => {
        let processManager;

        beforeAll(() => {
            processManager = new ProcessManager(managerConfig);
        });

        afterAll(async () => {
            if (processManager) {
                await processManager.stopAllProcesses();
                processManager.stopPoolWatcher();
                processManager.stopResourceMonitoring();
            }
        });

        test('should spawn a real process and communicate with it', async () => {
            // Get a process
            const processInfo = await processManager.getOrCreateProcessInPool();
            expect(processInfo).toBeDefined();
            expect(processInfo.port).toBeDefined();
            expect(processInfo.process).toBeDefined();
            expect(processInfo.process.pid).toBeGreaterThan(0);

            // Make a request to the process
            const response = await makeRequest(processInfo.port);
            expect(response).toBe('Hello, World from anotherApp.js!!');

            // Verify it's in the pool
            const poolInfo = processManager.getPoolInfo();
            expect(poolInfo.poolSize).toBeGreaterThan(0);
        });
    });

    describe('WorkerManager Integration', () => {
        let workerManager;

        beforeAll(() => {
            workerManager = new WorkerManager(managerConfig);
        });

        afterAll(async () => {
            if (workerManager) {
                await workerManager.stopAllWorkers();
                workerManager.stopPoolWatcher();
                workerManager.stopResourceMonitoring();
            }
        });

        test('should spawn a real worker and communicate with it', async () => {
            // Get a worker
            const workerInfo = await workerManager.getOrCreateWorkerInPool();
            expect(workerInfo).toBeDefined();
            expect(workerInfo.port).toBeDefined();
            expect(workerInfo.worker).toBeDefined();
            expect(workerInfo.worker.threadId).toBeGreaterThan(0);

            // Make a request to the worker
            // Note: Workers might take a split second to be ready to accept connections
            // simple retry logic or just wait a bit could be useful, 
            // but the manager should ideally yield when ready.
            // Let's try immediately, if flaky we add retry.

            // Wait a small amount of time for the http server in the worker to fully bind
            await new Promise(resolve => setTimeout(resolve, 500));

            const response = await makeRequest(workerInfo.port);
            expect(response).toBe('Hello, World from anotherApp.js!!');

            // Verify it's in the pool
            const poolInfo = workerManager.getPoolInfo();
            expect(poolInfo.poolSize).toBeGreaterThan(0);
        });
    });
});
