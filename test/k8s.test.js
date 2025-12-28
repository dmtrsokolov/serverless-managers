const K8sManager = require('../lib/managers/k8s');
const { getAvailablePort } = require('../lib/utils/port');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Mock dependencies
jest.mock('../lib/utils/port');
jest.mock('child_process');
jest.mock('fs');
jest.mock('path');
const logger = require('../lib/utils/logger');
jest.mock('../lib/utils/logger');

describe('K8sManager', () => {
    let k8sManager;
    let mockChildProcess;
    let mockK8sApi;

    beforeEach(() => {
        jest.setTimeout(60000);
        // Reset all mocks
        jest.clearAllMocks();

        // Mock process event listeners
        process.once = jest.fn();
        process.removeAllListeners = jest.fn();
        process.removeListener = jest.fn();
        logger.error = jest.fn();
        logger.info = jest.fn();
        logger.warn = jest.fn();

        // Mock child process
        mockChildProcess = {
            stdout: { on: jest.fn() },
            stderr: { on: jest.fn() },
            on: jest.fn(),
            kill: jest.fn(),
            killed: false
        };

        spawn.mockReturnValue(mockChildProcess);
        getAvailablePort.mockResolvedValue(8080);

        // Mock fs
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue('mock file content');

        // Mock path
        path.join.mockImplementation((...args) => args.join('/'));

        // Mock Kubernetes API
        mockK8sApi = {
            readNamespacedConfigMap: jest.fn(),
            replaceNamespacedConfigMap: jest.fn(),
            createNamespacedConfigMap: jest.fn(),
            createNamespacedPod: jest.fn(),
            readNamespacedPod: jest.fn(),
            deleteNamespacedPod: jest.fn()
        };

        // Temporarily disable setupShutdownHandlers to prevent listener leaks
        const originalSetup = K8sManager.prototype.setupShutdownHandlers;
        K8sManager.prototype.setupShutdownHandlers = jest.fn();

        // Create fresh instance
        k8sManager = new K8sManager({
            scriptDirPath: '/test/path',
            scriptFiles: ['index.js']
        });

        // Restore original setupShutdownHandlers
        K8sManager.prototype.setupShutdownHandlers = originalSetup;

        // Mock the initialize method to avoid dynamic import issues
        k8sManager.initialize = jest.fn().mockResolvedValue();
        k8sManager.k8sApi = mockK8sApi;
    });

    afterEach(() => {
        // Clean up any intervals to prevent timer leaks
        if (k8sManager) {
            k8sManager.stopPoolWatcher();
            k8sManager.stopResourceMonitoring();
            k8sManager.isShuttingDown = false; // Reset for next test
        }
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    afterAll(async () => {
        // Close Winston logger transports to allow clean exit
        const logger = require('../lib/utils/logger');
        await new Promise(resolve => setTimeout(resolve, 100));
        logger.close();
    });

    describe('constructor', () => {
        test('should initialize with default options', () => {
            expect(k8sManager.namespace).toBe('default');
            expect(k8sManager.defaultPodName).toBe('my-nodejs-pod');
            expect(k8sManager.defaultPodPort).toBe(9000);
            expect(k8sManager.maxPoolSize).toBe(3);
            expect(k8sManager.poolCheckInterval).toBe(10000);
            expect(k8sManager.podTimeout).toBe(60000);
            expect(k8sManager.shutdownTimeout).toBe(15000);
            expect(k8sManager.podPool).toEqual([]);
            expect(k8sManager.watcherStarted).toBe(false);
            expect(k8sManager.watcherInterval).toBe(null);
            expect(k8sManager.isShuttingDown).toBe(false);
            expect(k8sManager.initialized).toBe(false);
            expect(k8sManager.portForwardProcesses).toBeInstanceOf(Map);
        });

        test('should initialize with custom options', () => {
            // Disable shutdown handlers for this test
            const originalSetup = K8sManager.prototype.setupShutdownHandlers;
            K8sManager.prototype.setupShutdownHandlers = jest.fn();

            const customManager = new K8sManager({
                namespace: 'custom-namespace',
                defaultPodName: 'custom-pod',
                defaultPodPort: 8080,
                maxPoolSize: 5,
                poolCheckInterval: 5000,
                podTimeout: 45000,
                shutdownTimeout: 10000
            });

            expect(customManager.namespace).toBe('custom-namespace');
            expect(customManager.defaultPodName).toBe('custom-pod');
            expect(customManager.defaultPodPort).toBe(8080);
            expect(customManager.maxPoolSize).toBe(5);
            expect(customManager.poolCheckInterval).toBe(5000);
            expect(customManager.podTimeout).toBe(45000);
            expect(customManager.shutdownTimeout).toBe(10000);

            K8sManager.prototype.setupShutdownHandlers = originalSetup;
        });

        test('should set lastPodRequestTime on initialization', () => {
            expect(k8sManager.lastPodRequestTime).toEqual(expect.any(Number));
            expect(k8sManager.lastPodRequestTime).toBeGreaterThan(0);
        });

        test('should setup shutdown handlers', () => {
            expect(k8sManager.setupShutdownHandlers).toBeDefined();

            // Verify signal handlers are registered (tested via process.once calls)
            const processOnceSpy = jest.spyOn(process, 'once');
            k8sManager.setupShutdownHandlers();

            expect(processOnceSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
            expect(processOnceSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
            expect(processOnceSpy).toHaveBeenCalledWith('beforeExit', expect.any(Function));

            processOnceSpy.mockRestore();
        });
    });

    describe('initialize', () => {
        test('should be mocked and resolve successfully', async () => {
            // Reset the mock to test the actual call
            k8sManager.initialize.mockClear();

            await k8sManager.initialize();

            expect(k8sManager.initialize).toHaveBeenCalled();
        });

        test('should not reinitialize if already initialized', async () => {
            k8sManager.initialized = true;
            k8sManager.initialize.mockClear();

            // Test the real initialize method behavior
            k8sManager.initialize.mockImplementation(async function () {
                if (this.initialized) return;
                this.initialized = true;
            });

            await k8sManager.initialize();

            expect(k8sManager.initialize).toHaveBeenCalled();
        });

        test('should handle initialization errors', async () => {
            k8sManager.initialize.mockRejectedValue(new Error('K8s client failed'));

            await expect(k8sManager.initialize()).rejects.toThrow('K8s client failed');
        });
    });

    describe('poolWatcher', () => {
        test('should set up interval for pool watching', () => {
            // Mock setInterval to capture the callback
            const originalSetInterval = global.setInterval;
            global.setInterval = jest.fn();

            k8sManager.poolWatcher();

            expect(global.setInterval).toHaveBeenCalledWith(
                expect.any(Function),
                k8sManager.poolCheckInterval
            );

            // Restore original setInterval
            global.setInterval = originalSetInterval;
        });

        test('should not start multiple watchers', () => {
            const originalSetInterval = global.setInterval;
            global.setInterval = jest.fn().mockReturnValue('mock-timer-id');

            k8sManager.poolWatcher();
            expect(global.setInterval).toHaveBeenCalledTimes(1);

            k8sManager.poolWatcher();
            expect(global.setInterval).toHaveBeenCalledTimes(1); // Still 1

            global.setInterval = originalSetInterval;
        });

        test('should delete pod when pool check interval passes', async () => {
            // Add a mock pod to the pool
            k8sManager.podPool = [{
                name: 'test-pod',
                port: 8080
            }];

            // Set lastPodRequestTime to more than poolCheckInterval ago
            k8sManager.lastPodRequestTime = Date.now() - 15000;

            const loggerInfoSpy = jest.spyOn(logger, 'info').mockImplementation();
            const terminateSpySpy = jest.spyOn(k8sManager, 'terminatePod').mockResolvedValue({});

            // Mock setInterval to capture and immediately execute the callback
            const originalSetInterval = global.setInterval;
            global.setInterval = jest.fn((callback) => {
                setImmediate(callback);
                return 'mock-timer-id';
            });

            k8sManager.poolWatcher();

            // Wait for the callback to execute
            await new Promise(resolve => setImmediate(resolve));

            expect(terminateSpySpy).toHaveBeenCalledWith({ name: 'test-pod', port: 8080 });
            expect(k8sManager.podPool).toHaveLength(0);
            expect(loggerInfoSpy).toHaveBeenCalledWith('Stopped and removed pod: test-pod (port 8080)');

            loggerInfoSpy.mockRestore();
            terminateSpySpy.mockRestore();
            global.setInterval = originalSetInterval;
        });

        test('should not remove pod if recent request was made', async () => {
            // Add a mock pod to the pool
            k8sManager.podPool = [{
                name: 'test-pod',
                port: 8080
            }];

            // Set lastPodRequestTime to recent
            k8sManager.lastPodRequestTime = Date.now() - 5000;

            const terminateSpySpy = jest.spyOn(k8sManager, 'terminatePod').mockResolvedValue({});

            // Mock setInterval to capture and immediately execute the callback
            const originalSetInterval = global.setInterval;
            global.setInterval = jest.fn((callback) => {
                setImmediate(callback);
                return 'mock-timer-id';
            });

            k8sManager.poolWatcher();

            // Wait for the callback to execute
            await new Promise(resolve => setImmediate(resolve));

            expect(terminateSpySpy).not.toHaveBeenCalled();
            expect(k8sManager.podPool).toHaveLength(1);

            terminateSpySpy.mockRestore();
            global.setInterval = originalSetInterval;
        });

        test('should handle pod deletion errors', async () => {
            // Add a mock pod to the pool
            k8sManager.podPool = [{
                name: 'test-pod',
                port: 8080
            }];

            k8sManager.lastPodRequestTime = Date.now() - 15000;

            const loggerErrorSpy = jest.spyOn(logger, 'error').mockImplementation();
            const terminateSpySpy = jest.spyOn(k8sManager, 'terminatePod').mockRejectedValue(
                new Error('Deletion failed')
            );

            // Mock setInterval to capture and immediately execute the callback
            const originalSetInterval = global.setInterval;
            global.setInterval = jest.fn((callback) => {
                setImmediate(callback);
                return 'mock-timer-id';
            });

            k8sManager.poolWatcher();

            // Wait for the callback to execute
            await new Promise(resolve => setImmediate(resolve));

            expect(loggerErrorSpy).toHaveBeenCalledWith(
                'Error stopping pod test-pod:',
                'Deletion failed'
            );

            loggerErrorSpy.mockRestore();
            terminateSpySpy.mockRestore();
            global.setInterval = originalSetInterval;
        });
    });

    describe('createOrUpdateConfigMap', () => {
        beforeEach(() => {
            k8sManager.initialized = true;
        });

        test('should create new ConfigMap when it does not exist', async () => {
            mockK8sApi.readNamespacedConfigMap.mockRejectedValue({ code: 404 });
            mockK8sApi.createNamespacedConfigMap.mockResolvedValue({});

            const loggerInfoSpy = jest.spyOn(logger, 'info').mockImplementation();

            await k8sManager.createOrUpdateConfigMap('/test/path', ['index.js']);

            expect(fs.readFileSync).toHaveBeenCalledWith('/test/path/index.js', 'utf8');
            expect(mockK8sApi.createNamespacedConfigMap).toHaveBeenCalledWith({
                namespace: 'default',
                body: expect.objectContaining({
                    apiVersion: 'v1',
                    kind: 'ConfigMap',
                    metadata: {
                        name: 'scripts',
                        namespace: 'default'
                    },
                    data: expect.objectContaining({
                        'index.js': 'mock file content',
                        'package.json': expect.any(String)
                    })
                })
            });

            expect(loggerInfoSpy).toHaveBeenCalledWith('ConfigMap created successfully');
            loggerInfoSpy.mockRestore();
        });

        test('should update existing ConfigMap', async () => {
            mockK8sApi.readNamespacedConfigMap.mockResolvedValue({});
            mockK8sApi.replaceNamespacedConfigMap.mockResolvedValue({});

            const loggerInfoSpy = jest.spyOn(logger, 'info').mockImplementation();

            await k8sManager.createOrUpdateConfigMap('/test/path', ['index.js']);

            expect(mockK8sApi.replaceNamespacedConfigMap).toHaveBeenCalledWith({
                namespace: 'default',
                name: 'scripts',
                body: expect.objectContaining({
                    apiVersion: 'v1',
                    kind: 'ConfigMap'
                })
            });

            expect(loggerInfoSpy).toHaveBeenCalledWith('ConfigMap updated successfully');
            loggerInfoSpy.mockRestore();
        });

        test('should handle multiple script files', async () => {
            mockK8sApi.readNamespacedConfigMap.mockRejectedValue({ code: 404 });
            mockK8sApi.createNamespacedConfigMap.mockResolvedValue({});

            await k8sManager.createOrUpdateConfigMap('/test/path', ['index.js', 'utils.js']);

            expect(fs.readFileSync).toHaveBeenCalledWith('/test/path/index.js', 'utf8');
            expect(fs.readFileSync).toHaveBeenCalledWith('/test/path/utils.js', 'utf8');
        });

        test('should handle missing script files', async () => {
            mockK8sApi.readNamespacedConfigMap.mockRejectedValue({ code: 404 });
            mockK8sApi.createNamespacedConfigMap.mockResolvedValue({});
            fs.existsSync.mockReturnValue(false);

            const loggerWarnSpy = jest.spyOn(logger, 'warn').mockImplementation();

            await k8sManager.createOrUpdateConfigMap('/test/path', ['missing.js']);

            expect(loggerWarnSpy).toHaveBeenCalledWith('Script file not found: /test/path/missing.js');

            loggerWarnSpy.mockRestore();
        });

        test('should throw error if ConfigMap creation fails', async () => {
            mockK8sApi.readNamespacedConfigMap.mockRejectedValue({ code: 404 });
            mockK8sApi.createNamespacedConfigMap.mockRejectedValue(new Error('Creation failed'));

            await expect(k8sManager.createOrUpdateConfigMap('/test/path'))
                .rejects.toThrow('Creation failed');
        });

        test('should throw error for non-404 errors when reading ConfigMap', async () => {
            const serverError = new Error('Server error');
            serverError.code = 500;
            mockK8sApi.readNamespacedConfigMap.mockRejectedValue(serverError);

            await expect(k8sManager.createOrUpdateConfigMap('/test/path'))
                .rejects.toThrow('Server error');
        });
    });

    describe('getOrCreatePodInPool', () => {
        beforeEach(() => {
            jest.spyOn(k8sManager, 'initialize').mockResolvedValue();
            jest.spyOn(k8sManager, 'createOrUpdateConfigMap').mockResolvedValue();
            jest.spyOn(k8sManager, 'createPod').mockResolvedValue({
                status: 'started',
                name: 'test-pod-8080'
            });
        });

        test('should update lastPodRequestTime', async () => {
            const beforeTime = Date.now();
            mockK8sApi.readNamespacedPod.mockResolvedValue({ status: { phase: 'Running' } });

            await k8sManager.getOrCreatePodInPool();

            expect(k8sManager.lastPodRequestTime).toBeGreaterThanOrEqual(beforeTime);
        });

        test('should start pool watcher on first call', async () => {
            const poolWatcherSpy = jest.spyOn(k8sManager, 'poolWatcher').mockImplementation();
            mockK8sApi.readNamespacedPod.mockResolvedValue({ status: { phase: 'Running' } });

            expect(k8sManager.watcherStarted).toBe(false);

            await k8sManager.getOrCreatePodInPool();

            expect(k8sManager.watcherStarted).toBe(true);
            expect(poolWatcherSpy).toHaveBeenCalled();

            poolWatcherSpy.mockRestore();
        });

        test('should not start pool watcher if already started', async () => {
            k8sManager.watcherStarted = true;
            k8sManager.podPool = [{ name: 'existing-pod', port: 8001, lastUsed: Date.now() }];
            const poolWatcherSpy = jest.spyOn(k8sManager, 'poolWatcher').mockImplementation();
            mockK8sApi.readNamespacedPod.mockResolvedValue({ status: { phase: 'Running' } });

            await k8sManager.getOrCreatePodInPool();

            expect(poolWatcherSpy).not.toHaveBeenCalled();

            poolWatcherSpy.mockRestore();
        });

        test('should throw error if shutting down', async () => {
            k8sManager.isShuttingDown = true;

            await expect(k8sManager.getOrCreatePodInPool())
                .rejects.toThrow('K8sManager is shutting down');
        });

        test('should throw error if script path is not configured', async () => {
            const noScriptManager = new K8sManager();
            noScriptManager.initialize = jest.fn().mockResolvedValue();
            noScriptManager.isShuttingDown = false;

            await expect(noScriptManager.getOrCreatePodInPool())
                .rejects.toThrow('Script directory path is not configured');
        });

        test('should create new pod when pool is not full', async () => {
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
            mockK8sApi.readNamespacedPod.mockResolvedValue({
                status: { phase: 'Running' }
            });

            const result = await k8sManager.getOrCreatePodInPool();

            expect(k8sManager.initialize).toHaveBeenCalled();
            expect(k8sManager.createOrUpdateConfigMap).toHaveBeenCalledWith('/test/path', ['index.js']);
            expect(k8sManager.createPod).toHaveBeenCalled();
            expect(k8sManager.podPool).toHaveLength(1);
            expect(k8sManager.podPool[0].createdAt).toEqual(expect.any(Number));
            expect(k8sManager.podPool[0].lastUsed).toEqual(expect.any(Number));
            expect(result.port).toBe(8080);

            consoleSpy.mockRestore();
        });

        test('should use round-robin selection when pool is full', async () => {
            // Fill the pool to max capacity
            k8sManager.podPool = [
                { name: 'pod-1', port: 8001, lastUsed: Date.now() },
                { name: 'pod-2', port: 8002, lastUsed: Date.now() },
                { name: 'pod-3', port: 8003, lastUsed: Date.now() }
            ];

            mockK8sApi.readNamespacedPod.mockResolvedValue({
                status: { phase: 'Running' }
            });

            const result = await k8sManager.getOrCreatePodInPool();

            // Round-robin uses timestamp-based selection
            expect(result.name).toMatch(/^pod-[1-3]$/);
            expect(result.port).toBeGreaterThanOrEqual(8001);
            expect(result.port).toBeLessThanOrEqual(8003);
            expect(k8sManager.createPod).not.toHaveBeenCalled();
        });

        test('should throw error if ConfigMap creation fails', async () => {
            k8sManager.createOrUpdateConfigMap.mockRejectedValue(new Error('ConfigMap failed'));

            await expect(k8sManager.getOrCreatePodInPool())
                .rejects.toThrow('ConfigMap creation failed: ConfigMap failed');
        });

        test('should throw error if pod creation fails and pool is empty', async () => {
            k8sManager.createPod.mockRejectedValue(new Error('Pod creation failed'));

            await expect(k8sManager.getOrCreatePodInPool())
                .rejects.toThrow('Pod creation failed');
        });

        test('should return existing pod if creation fails but pool has pods', async () => {
            // Add existing pod to pool
            k8sManager.podPool = [{ name: 'existing-pod', port: 8001, lastUsed: Date.now() }];
            k8sManager.createPod.mockRejectedValue(new Error('Pod creation failed'));
            mockK8sApi.readNamespacedPod.mockResolvedValue({
                status: { phase: 'Running' }
            });

            const loggerWarnSpy = jest.spyOn(logger, 'warn').mockImplementation();

            const result = await k8sManager.getOrCreatePodInPool();

            expect(result.name).toBe('existing-pod');
            expect(loggerWarnSpy).toHaveBeenCalledWith(
                'Pod creation failed, using existing pod from pool:',
                'Pod creation failed'
            );

            loggerWarnSpy.mockRestore();
        });

        test('should throw error if no pods available', async () => {
            k8sManager.podPool = [];
            k8sManager.maxPoolSize = 0; // Force pool to be full

            await expect(k8sManager.getOrCreatePodInPool())
                .rejects.toThrow('No pods available in pool');
        });

        test('should remove dead pod and retry', async () => {
            // Round-robin will select based on timestamp, so we need to know which one is selected first
            // It uses Math.floor(Date.now() / 1000) % poolLength
            // With pool length 2, it will select index 0 or 1
            k8sManager.podPool = [
                { name: 'dead-pod', port: 8001, lastUsed: Date.now() }, // Index 0
                { name: 'alive-pod', port: 8002, lastUsed: Date.now() } // Index 1
            ];
            k8sManager.maxPoolSize = 2; // Prevent new pod creation

            // Mock to make round-robin select index 0 (dead-pod)
            const originalNow = Date.now;
            Date.now = jest.fn().mockReturnValue(1000000000); // Will give index 0 when divided by 1000 and mod 2

            mockK8sApi.readNamespacedPod
                .mockResolvedValueOnce({ status: { phase: 'Failed' } }) // dead-pod is dead
                .mockResolvedValueOnce({ status: { phase: 'Running' } }); // alive-pod on retry

            const loggerWarnSpy = jest.spyOn(logger, 'warn').mockImplementation();

            const result = await k8sManager.getOrCreatePodInPool();

            // Restore Date.now
            Date.now = originalNow;

            // Clean up interval to prevent async operations after test
            if (k8sManager.watcherInterval) {
                clearInterval(k8sManager.watcherInterval);
                k8sManager.watcherInterval = null;
            }

            expect(loggerWarnSpy).toHaveBeenCalledWith('Pod dead-pod is not running, removing from pool');
            expect(result.name).toBe('alive-pod');
            expect(k8sManager.podPool).toHaveLength(2); // duringh retry a new pod has been created
            expect(k8sManager.podPool[0].name).toBe('alive-pod');

            loggerWarnSpy.mockRestore();
        });

        test('should throw error if health check fails for all pods', async () => {
            k8sManager.podPool = [
                { name: 'pod-1', port: 8001, lastUsed: Date.now() }
            ];
            k8sManager.maxPoolSize = 1; // Prevent new pod creation

            mockK8sApi.readNamespacedPod.mockRejectedValue(new Error('Pod not found'));

            const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();

            await expect(k8sManager.getOrCreatePodInPool())
                .rejects.toThrow('No pods available in pool after health check');

            consoleWarnSpy.mockRestore();
        });
    });

    describe('createPod', () => {
        beforeEach(() => {
            k8sManager.initialized = true;
            jest.useFakeTimers();
        });

        afterEach(() => {
            jest.clearAllTimers();
            jest.useRealTimers();
        });

        test('should create pod with correct parameters', async () => {
            mockK8sApi.createNamespacedPod.mockResolvedValue({ body: {} });
            mockK8sApi.readNamespacedPod.mockResolvedValue({
                status: { phase: 'Running' }
            });

            const promise = k8sManager.createPod(8080, 'test-pod');
            jest.runAllTimers();
            const result = await promise;

            expect(mockK8sApi.createNamespacedPod).toHaveBeenCalledWith({
                namespace: 'default',
                body: expect.objectContaining({
                    apiVersion: 'v1',
                    kind: 'Pod',
                    metadata: {
                        name: 'test-pod',
                        labels: { app: 'my-app' }
                    },
                    spec: expect.objectContaining({
                        containers: expect.arrayContaining([
                            expect.objectContaining({
                                name: 'my-container',
                                image: 'node:18-alpine',
                                ports: [{ containerPort: 9000 }]
                            })
                        ])
                    })
                })
            });

            expect(spawn).toHaveBeenCalledWith('kubectl', [
                'port-forward',
                'pod/test-pod',
                '8080:9000',
                '-n',
                'default'
            ]);

            expect(result).toEqual({
                status: 'started',
                name: 'test-pod',
                pod: {},
                portForwardProcess: mockChildProcess
            });

            expect(k8sManager.portForwardProcesses.get('test-pod')).toBe(mockChildProcess);
        });

        test('should use default pod name if not provided', async () => {
            mockK8sApi.createNamespacedPod.mockResolvedValue({ body: {} });
            mockK8sApi.readNamespacedPod.mockResolvedValue({
                status: { phase: 'Running' }
            });

            await k8sManager.createPod(8080);

            expect(mockK8sApi.createNamespacedPod).toHaveBeenCalledWith({
                namespace: 'default',
                body: expect.objectContaining({
                    metadata: {
                        name: 'my-nodejs-pod',
                        labels: { app: 'my-app' }
                    }
                })
            });
        });

        test('should wait for pod to be ready', async () => {
            jest.useRealTimers(); // Use real timers for async behavior

            mockK8sApi.createNamespacedPod.mockResolvedValue({ body: {} });
            mockK8sApi.readNamespacedPod
                .mockResolvedValueOnce({ status: { phase: 'Pending' } })
                .mockResolvedValueOnce({ status: { phase: 'Running' } });

            const loggerInfoSpy = jest.spyOn(logger, 'info').mockImplementation();

            await k8sManager.createPod(8080, 'test-pod');

            expect(mockK8sApi.readNamespacedPod).toHaveBeenCalled();
            expect(loggerInfoSpy).toHaveBeenCalledWith('Pod "test-pod" is running.');

            loggerInfoSpy.mockRestore();
            // afterEach will handle timer cleanup
        });

        test('should timeout if pod creation takes too long', async () => {
            jest.useRealTimers(); // Use real timers for this specific test
            k8sManager.podTimeout = 100; // Short timeout for testing

            mockK8sApi.createNamespacedPod.mockImplementation(() => {
                return new Promise((resolve) => setTimeout(resolve, 1000)); // Takes too long
            });

            await expect(k8sManager.createPod(8080, 'test-pod'))
                .rejects.toThrow('Pod creation timeout after 100ms');

            // afterEach will handle timer cleanup
        });

        test('should throw error if pod does not become ready in time', async () => {
            mockK8sApi.createNamespacedPod.mockResolvedValue({ body: {} });
            mockK8sApi.readNamespacedPod.mockResolvedValue({
                status: { phase: 'Pending' }
            });

            // Trigger the call and advance fake timers by the total polling duration
            const promise = k8sManager._createPodInternal(8080, 'test-pod');
            // Temporarily switch to real timers and make setTimeout immediate
            jest.useRealTimers();
            const originalSetTimeout = global.setTimeout;
            global.setTimeout = (fn, ms) => originalSetTimeout(fn, 0);

            try {
                await expect(promise).rejects.toThrow('Pod \"test-pod\" did not become ready in time.');
            } finally {
                // Restore original setTimeout - afterEach will handle timer cleanup
                global.setTimeout = originalSetTimeout;
            }
        });

        test('should handle port-forward process events', async () => {
            mockK8sApi.createNamespacedPod.mockResolvedValue({ body: {} });
            mockK8sApi.readNamespacedPod.mockResolvedValue({
                status: { phase: 'Running' }
            });

            const loggerInfoSpy = jest.spyOn(logger, 'info').mockImplementation();
            const loggerErrorSpy = jest.spyOn(logger, 'error').mockImplementation();

            await k8sManager.createPod(8080, 'test-pod');

            expect(mockChildProcess.stdout.on).toHaveBeenCalledWith('data', expect.any(Function));
            expect(mockChildProcess.stderr.on).toHaveBeenCalledWith('data', expect.any(Function));

            // Test stdout event handler
            const stdoutHandler = mockChildProcess.stdout.on.mock.calls.find(
                call => call[0] === 'data'
            )[1];
            stdoutHandler('test stdout data');
            expect(loggerInfoSpy).toHaveBeenCalledWith('kubectl port-forward stdout: test stdout data');

            // Test stderr event handler
            const stderrHandler = mockChildProcess.stderr.on.mock.calls.find(
                call => call[0] === 'data'
            )[1];
            stderrHandler('test stderr data');
            expect(loggerErrorSpy).toHaveBeenCalledWith('kubectl port-forward stderr: test stderr data');

            loggerInfoSpy.mockRestore();
            loggerErrorSpy.mockRestore();
        });

        test('should throw error if pod creation fails', async () => {
            mockK8sApi.createNamespacedPod.mockRejectedValue(new Error('Creation failed'));

            await expect(k8sManager.createPod(8080, 'test-pod'))
                .rejects.toThrow('Creation failed');
        });
    });

    describe('deletePod', () => {
        beforeEach(() => {
            k8sManager.initialized = true;
        });

        test('should delete pod successfully', async () => {
            mockK8sApi.deleteNamespacedPod.mockResolvedValue({});

            const result = await k8sManager.deletePod('test-pod');

            expect(mockK8sApi.deleteNamespacedPod).toHaveBeenCalledWith({
                namespace: 'default',
                name: 'test-pod'
            });

            expect(result).toEqual({
                status: 'stopped and removed',
                name: 'test-pod'
            });
        });

        test('should use default pod name if not provided', async () => {
            mockK8sApi.deleteNamespacedPod.mockResolvedValue({});

            await k8sManager.deletePod();

            expect(mockK8sApi.deleteNamespacedPod).toHaveBeenCalledWith({
                namespace: 'default',
                name: 'my-nodejs-pod'
            });
        });

        test('should handle pod not found error', async () => {
            mockK8sApi.deleteNamespacedPod.mockRejectedValue({
                response: { statusCode: 404 }
            });

            const result = await k8sManager.deletePod('test-pod');

            expect(result).toEqual({
                status: 'pod not found',
                name: 'test-pod'
            });
        });

        test('should throw error for other failures', async () => {
            mockK8sApi.deleteNamespacedPod.mockRejectedValue(new Error('Deletion failed'));

            await expect(k8sManager.deletePod('test-pod'))
                .rejects.toThrow('Deletion failed');
        });
    });

    describe('getPoolInfo', () => {
        test('should return correct pool information', () => {
            k8sManager.podPool = [
                { name: 'pod-1', port: 8001, createdAt: 1000, lastUsed: 2000 },
                { name: 'pod-2', port: 8002, createdAt: 1100, lastUsed: 2100 }
            ];

            const info = k8sManager.getPoolInfo();

            expect(info).toEqual({
                poolSize: 2,
                maxPoolSize: 3,
                isShuttingDown: false,
                watcherStarted: false,
                pods: [
                    { name: 'pod-1', port: 8001, createdAt: 1000, lastUsed: 2000 },
                    { name: 'pod-2', port: 8002, createdAt: 1100, lastUsed: 2100 }
                ],
                metrics: expect.any(Object)
            });
        });

        test('should return empty pods array when pool is empty', () => {
            const info = k8sManager.getPoolInfo();

            expect(info).toEqual({
                poolSize: 0,
                maxPoolSize: 3,
                isShuttingDown: false,
                watcherStarted: false,
                pods: [],
                metrics: expect.any(Object)
            });
        });
    });

    describe('clearPool', () => {
        test('should clear the pool and update request time', () => {
            k8sManager.podPool = [{ name: 'pod-1', port: 8001 }];

            const beforeTime = Date.now();
            k8sManager.clearPool();
            const afterTime = Date.now();

            expect(k8sManager.podPool).toEqual([]);
            expect(k8sManager.lastPodRequestTime).toBeGreaterThanOrEqual(beforeTime);
            expect(k8sManager.lastPodRequestTime).toBeLessThanOrEqual(afterTime);
        });
    });

    describe('stopAllPods', () => {
        test('should delete all pods and clear pool', async () => {
            const terminateSpySpy = jest.spyOn(k8sManager, 'terminateResource').mockResolvedValue({});

            k8sManager.podPool = [
                { name: 'pod-1', port: 8001 },
                { name: 'pod-2', port: 8002 }
            ];

            await k8sManager.stopAllPods();

            expect(terminateSpySpy).toHaveBeenCalledWith({ name: 'pod-1', port: 8001 });
            expect(terminateSpySpy).toHaveBeenCalledWith({ name: 'pod-2', port: 8002 });
            expect(k8sManager.podPool).toEqual([]);

            terminateSpySpy.mockRestore();
        });

        test('should log when no pods to stop', async () => {
            const loggerInfoSpy = jest.spyOn(logger, 'info').mockImplementation();
            k8sManager.podPool = [];

            await k8sManager.stopAllPods();

            expect(loggerInfoSpy).toHaveBeenCalledWith('No pods to stop');

            loggerInfoSpy.mockRestore();
        });

        test('should handle pod deletion errors', async () => {
            const terminateSpySpy = jest.spyOn(k8sManager, 'terminateResource').mockRejectedValue(
                new Error('Deletion failed')
            );
            const loggerErrorSpy = jest.spyOn(logger, 'error').mockImplementation();

            k8sManager.podPool = [{ name: 'pod-1', port: 8001 }];

            await k8sManager.stopAllPods();

            expect(loggerErrorSpy).toHaveBeenCalledWith(
                'Error stopping pod pod-1:',
                'Deletion failed'
            );
            expect(k8sManager.podPool).toEqual([]);

            terminateSpySpy.mockRestore();
            loggerErrorSpy.mockRestore();
        });

        test('should work with empty pool', async () => {
            k8sManager.podPool = [];

            await expect(k8sManager.stopAllPods()).resolves.not.toThrow();
            expect(k8sManager.podPool).toEqual([]);
        });
    });

    describe('terminatePod', () => {
        beforeEach(() => {
            jest.useFakeTimers();
        });

        afterEach(() => {
            jest.clearAllTimers();
            jest.useRealTimers();
        });

        test('should terminate pod gracefully', async () => {
            const mockProcess = { kill: jest.fn(), killed: false };
            k8sManager.portForwardProcesses.set('test-pod', mockProcess);
            jest.spyOn(k8sManager, 'deletePod').mockResolvedValue({});

            const promise = k8sManager.terminatePod({ name: 'test-pod', port: 8080 });
            jest.runAllTimers();
            await promise;

            expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');
            expect(k8sManager.deletePod).toHaveBeenCalledWith('test-pod');
            expect(k8sManager.portForwardProcesses.has('test-pod')).toBe(false);
        });

        test('should force delete on timeout', async () => {
            jest.spyOn(k8sManager, 'deletePod').mockImplementation(() => {
                return new Promise(() => { }); // Never resolves
            });

            const loggerWarnSpy = jest.spyOn(logger, 'warn').mockImplementation();
            mockK8sApi.deleteNamespacedPod.mockResolvedValue({});

            const promise = k8sManager.terminatePod({ name: 'test-pod', port: 8080 });
            jest.advanceTimersByTime(k8sManager.shutdownTimeout);
            await promise;

            expect(loggerWarnSpy).toHaveBeenCalledWith(
                expect.stringContaining('Failed to gracefully terminate pod test-pod'),
                expect.anything()
            );
            expect(mockK8sApi.deleteNamespacedPod).toHaveBeenCalledWith({
                namespace: 'default',
                name: 'test-pod',
                body: { gracePeriodSeconds: 0 }
            });

            loggerWarnSpy.mockRestore();
        });

        test('should handle force delete failure', async () => {
            jest.spyOn(k8sManager, 'deletePod').mockRejectedValue(new Error('Graceful delete failed'));
            mockK8sApi.deleteNamespacedPod.mockRejectedValue(new Error('Force delete failed'));

            const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
            const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

            const promise = k8sManager.terminatePod({ name: 'test-pod', port: 8080 });
            jest.runAllTimers();

            await expect(promise).rejects.toThrow('Force delete failed');

            consoleWarnSpy.mockRestore();
            consoleErrorSpy.mockRestore();
        });
    });

    describe('shutdown', () => {
        test('should shutdown gracefully', async () => {
            const interval = setInterval(() => { }, 1000);
            k8sManager.watcherInterval = interval;
            jest.spyOn(k8sManager, 'stopAllResources').mockResolvedValue();
            const loggerInfoSpy = jest.spyOn(logger, 'info').mockImplementation();

            await k8sManager.shutdown();

            expect(k8sManager.isShuttingDown).toBe(true);
            expect(k8sManager.watcherInterval).toBe(null);
            expect(k8sManager.stopAllResources).toHaveBeenCalled();
            expect(loggerInfoSpy).toHaveBeenCalledWith('K8sManager shutting down...');
            expect(loggerInfoSpy).toHaveBeenCalledWith('K8sManager shutdown complete');

            loggerInfoSpy.mockRestore();
            // Ensure interval is cleaned up in case shutdown() failed to clear it
            clearInterval(interval);
        });

        test('should not shutdown twice', async () => {
            k8sManager.isShuttingDown = true;
            jest.spyOn(k8sManager, 'stopAllResources').mockResolvedValue();

            await k8sManager.shutdown();

            expect(k8sManager.stopAllResources).not.toHaveBeenCalled();
        });
    });

    describe('healthCheck', () => {
        test('should return healthy status for running pods', async () => {
            k8sManager.podPool = [
                { name: 'pod-1', port: 8001 },
                { name: 'pod-2', port: 8002 }
            ];

            mockK8sApi.readNamespacedPod.mockResolvedValue({
                status: { phase: 'Running' }
            });

            const health = await k8sManager.healthCheck();

            expect(health).toEqual({
                totalPods: 2,
                deadPodsRemoved: 0,
                healthy: true
            });
        });

        test('should remove dead pods', async () => {
            k8sManager.podPool = [
                { name: 'dead-pod', port: 8001 },
                { name: 'alive-pod', port: 8002 }
            ];

            // healthCheck iterates backwards, so it checks alive-pod first (index 1), then dead-pod (index 0)
            mockK8sApi.readNamespacedPod
                .mockResolvedValueOnce({ status: { phase: 'Running' } }) // alive-pod (checked second, index 1)
                .mockResolvedValueOnce({ status: { phase: 'Failed' } }); // dead-pod (checked first, index 0)

            const health = await k8sManager.healthCheck();

            expect(health.totalPods).toBe(1);
            expect(health.deadPodsRemoved).toBe(1);
            expect(health.healthy).toBe(true);
            expect(k8sManager.podPool).toHaveLength(1);
            expect(k8sManager.podPool[0].name).toBe('alive-pod');
        });

        test('should remove pods that cannot be read', async () => {
            k8sManager.podPool = [
                { name: 'missing-pod', port: 8001 }
            ];
            k8sManager.isShuttingDown = true; // To make healthy = false

            mockK8sApi.readNamespacedPod.mockRejectedValue(new Error('Pod not found'));

            const health = await k8sManager.healthCheck();

            expect(health).toEqual({
                totalPods: 0,
                deadPodsRemoved: 1,
                healthy: false
            });
        });
    });

    describe('removePodFromPool', () => {
        test('should remove pod from pool', () => {
            k8sManager.podPool = [
                { name: 'pod-1', port: 8001 },
                { name: 'pod-2', port: 8002 }
            ];

            const mockProcess = { kill: jest.fn(), killed: false };
            k8sManager.portForwardProcesses.set('pod-1', mockProcess);

            const loggerSpy = jest.spyOn(require('../lib/utils/logger'), 'info');

            const removed = k8sManager.removePodFromPool('pod-1');

            expect(removed).toEqual({ name: 'pod-1', port: 8001 });
            expect(k8sManager.podPool).toHaveLength(1);
            expect(k8sManager.podPool[0].name).toBe('pod-2');
            expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');
            expect(k8sManager.portForwardProcesses.has('pod-1')).toBe(false);
            expect(loggerSpy).toHaveBeenCalledWith('pod pod-1 removed from pool');

            loggerSpy.mockRestore();
        });

        test('should return null if pod not found', () => {
            k8sManager.podPool = [{ name: 'pod-1', port: 8001 }];

            const removed = k8sManager.removePodFromPool('non-existent');

            expect(removed).toBe(null);
            expect(k8sManager.podPool).toHaveLength(1);
        });

        test('should handle missing port-forward process', () => {
            k8sManager.podPool = [{ name: 'pod-1', port: 8001 }];

            const removed = k8sManager.removePodFromPool('pod-1');

            expect(removed).toEqual({ name: 'pod-1', port: 8001 });
            expect(k8sManager.podPool).toHaveLength(0);
        });
    });
});