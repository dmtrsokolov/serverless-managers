const path = require('path');
const http = require('http');
const { ProcessManager, WorkerManager, DockerManager } = require('../../lib');

// robust request helper
const makeRequest = (port) => {
    return new Promise((resolve, reject) => {
        // Use 127.0.0.1 to avoid IPv6 issues with Docker bindings
        const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => resolve(data));
        });
        req.on('error', reject);
    });
};

const scriptDirPath = path.join(__dirname, '../../examples/scripts');
// Use simple.js which has no dependencies (like express) so it works in node:alpine
const scriptFiles = ['simple.js', 'greet.js'];
const managerConfig = { scriptDirPath, scriptFiles };

describe('System Integration Tests', () => {
    // Increase timeout for integration tests
    // Increase timeout for integration tests (Docker pulling can take time)
    jest.setTimeout(60000);

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

    describe('DockerManager Integration', () => {
        let dockerManager;

        beforeAll(() => {
            // Ensure image exists
            try {
                require('child_process').execSync('docker pull node:20-alpine');
            } catch (e) {
                console.warn('Failed to pull image, assuming it exists or connection failed:', e.message);
            }

            // Use node:20-alpine for a smaller image
            dockerManager = new DockerManager({
                ...managerConfig,
                defaultImageName: 'node:20-alpine',
                defaultContainerName: 'integration-test-container'
            });
        });

        afterAll(async () => {
            if (dockerManager) {
                await dockerManager.stopAllContainers();
                dockerManager.stopPoolWatcher();
                dockerManager.stopResourceMonitoring();
            }
        });

        test('should spawn a real container and communicate with it', async () => {
            // This might take a while if image needs to be pulled
            const containerInfo = await dockerManager.getOrCreateContainerInPool();
            expect(containerInfo).toBeDefined();
            expect(containerInfo.port).toBeDefined();
            expect(containerInfo.id).toBeDefined();

            // Wait for container to be ready to accept connections
            // Containers are slower to start than processes/workers
            await new Promise(resolve => setTimeout(resolve, 3000));

            // Debug: Check if container is still alive
            const isAlive = await dockerManager.isResourceAlive(containerInfo);
            if (!isAlive) {
                try {
                    const logs = require('child_process').execSync(`docker logs ${containerInfo.name}`);
                    console.error('Container died. Logs:', logs.toString());
                } catch (e) {
                    console.error('Failed to get logs:', e.message);
                }
            }
            expect(isAlive).toBe(true);

            const response = await makeRequest(containerInfo.port);
            expect(response).toBe('Hello, World from anotherApp.js!!');

            const poolInfo = dockerManager.getPoolInfo();
            expect(poolInfo.poolSize).toBeGreaterThan(0);
        });
    });
});

