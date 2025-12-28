const WorkerManager = require('../lib/managers/worker');
const { getAvailablePort } = require('../lib/utils/port');
const { Worker } = require('worker_threads');
const logger = require('../lib/utils/logger');

// Mock dependencies
jest.mock('worker_threads');
jest.mock('../lib/utils/port');
jest.mock('../lib/utils/logger');

describe('WorkerManager', () => {
    let workerManager;
    let mockWorker;

    beforeEach(() => {
        jest.setTimeout(60000);
        // Reset all mocks
        jest.clearAllMocks();

        logger.error = jest.fn();
        logger.info = jest.fn();

        // Mock Worker class
        mockWorker = {
            on: jest.fn(),
            terminate: jest.fn().mockResolvedValue(undefined),
            kill: jest.fn(),
            threadId: 12345
        };

        Worker.mockImplementation(() => mockWorker);
        getAvailablePort.mockResolvedValue(8080);

        // Mock process event listeners
        process.once = jest.fn();
        process.removeAllListeners = jest.fn();

        // Create fresh instance
        workerManager = new WorkerManager();
    });

    afterEach(() => {
        // Clean up any intervals to prevent timer leaks
        if (workerManager) {
            workerManager.stopPoolWatcher();
            workerManager.isShuttingDown = false; // Reset for next test
        }
        jest.clearAllTimers();
    });

    describe('constructor', () => {
        test('should initialize with default options', () => {
            expect(workerManager.maxPoolSize).toBe(3);
            expect(workerManager.poolCheckInterval).toBe(10000);
            expect(workerManager.workerTimeout).toBe(30000);
            expect(workerManager.shutdownTimeout).toBe(5000);
            expect(workerManager.workerPool).toEqual([]);
            expect(workerManager.watcherStarted).toBe(false);
            expect(workerManager.isShuttingDown).toBe(false);
            expect(process.once).toHaveBeenCalledTimes(3);
        });

        test('should initialize with custom options', () => {
            const customManager = new WorkerManager({
                maxPoolSize: 5,
                poolCheckInterval: 5000,
                workerTimeout: 15000,
                shutdownTimeout: 3000
            });

            expect(customManager.maxPoolSize).toBe(5);
            expect(customManager.poolCheckInterval).toBe(5000);
            expect(customManager.workerTimeout).toBe(15000);
            expect(customManager.shutdownTimeout).toBe(3000);
        });

        test('should set lastWorkerRequestTime on initialization', () => {
            const beforeTime = Date.now();
            const manager = new WorkerManager();
            const afterTime = Date.now();

            expect(manager.lastWorkerRequestTime).toBeGreaterThanOrEqual(beforeTime);
            expect(manager.lastWorkerRequestTime).toBeLessThanOrEqual(afterTime);
        });
    });

    describe('poolWatcher', () => {
        test('should set up interval for pool watching', () => {
            // Mock setInterval to capture the callback
            const originalSetInterval = global.setInterval;
            global.setInterval = jest.fn();

            workerManager.poolWatcher();

            expect(global.setInterval).toHaveBeenCalledWith(
                expect.any(Function),
                workerManager.poolCheckInterval
            );

            // Restore original setInterval
            global.setInterval = originalSetInterval;
        });

        test('should terminate and remove worker when pool check interval passes', async () => {
            // Add a mock worker to the pool
            workerManager.workerPool = [{
                name: 'test-worker',
                port: 8080,
                worker: mockWorker
            }];

            // Set lastWorkerRequestTime to more than poolCheckInterval ago
            workerManager.lastWorkerRequestTime = Date.now() - 15000;

            const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

            // Mock setInterval to capture and immediately execute the callback
            const originalSetInterval = global.setInterval;
            global.setInterval = jest.fn((callback) => {
                // Execute the callback immediately for testing
                setImmediate(callback);
                return 'mock-timer-id';
            });

            workerManager.poolWatcher();

            // Wait for the callback to execute
            await new Promise(resolve => setImmediate(resolve));

            expect(mockWorker.terminate).toHaveBeenCalled();
            expect(workerManager.workerPool).toHaveLength(0);
            expect(consoleSpy).toHaveBeenCalledWith('Stopped and removed worker: test-worker');

            consoleSpy.mockRestore();
            global.setInterval = originalSetInterval;
        });

        test('should not remove worker if recent request was made', async () => {
            // Add a mock worker to the pool
            workerManager.workerPool = [{
                name: 'test-worker',
                port: 8080,
                worker: mockWorker
            }];

            // Set lastWorkerRequestTime to recent
            workerManager.lastWorkerRequestTime = Date.now() - 5000;

            // Mock setInterval to capture and immediately execute the callback
            const originalSetInterval = global.setInterval;
            global.setInterval = jest.fn((callback) => {
                setImmediate(callback);
                return 'mock-timer-id';
            });

            workerManager.poolWatcher();

            // Wait for the callback to execute
            await new Promise(resolve => setImmediate(resolve));

            expect(mockWorker.terminate).not.toHaveBeenCalled();
            expect(workerManager.workerPool).toHaveLength(1);

            global.setInterval = originalSetInterval;
        });

        test('should handle worker termination errors', async () => {
            // Add a mock worker to the pool
            workerManager.workerPool = [{
                name: 'test-worker',
                port: 8080,
                worker: mockWorker
            }];

            mockWorker.terminate.mockRejectedValue(new Error('Termination failed'));
            workerManager.lastWorkerRequestTime = Date.now() - 15000;

            const loggerErrorSpy = jest.spyOn(logger, 'error').mockImplementation();

            // Mock setInterval to capture and immediately execute the callback
            const originalSetInterval = global.setInterval;
            global.setInterval = jest.fn((callback) => {
                setImmediate(callback);
                return 'mock-timer-id';
            });

            workerManager.poolWatcher();

            // Wait for the callback to execute
            await new Promise(resolve => setImmediate(resolve));

            expect(loggerErrorSpy).toHaveBeenCalledWith(
                'Error stopping worker test-worker:',
                'Termination failed'
            );

            loggerErrorSpy.mockRestore();
            global.setInterval = originalSetInterval;
        });

        test('should not do anything if pool is empty', async () => {
            workerManager.workerPool = [];
            workerManager.lastWorkerRequestTime = Date.now() - 15000;

            // Mock setInterval to capture and immediately execute the callback
            const originalSetInterval = global.setInterval;
            global.setInterval = jest.fn((callback) => {
                setImmediate(callback);
                return 'mock-timer-id';
            });

            workerManager.poolWatcher();

            // Wait for the callback to execute
            await new Promise(resolve => setImmediate(resolve));

            expect(mockWorker.terminate).not.toHaveBeenCalled();

            global.setInterval = originalSetInterval;
        });
    });

    describe('getOrCreateWorkerInPool', () => {
        test('should update lastWorkerRequestTime', async () => {
            const beforeTime = Date.now();

            // Mock successful worker creation
            mockWorker.on.mockImplementation((event, callback) => {
                if (event === 'online') {
                    setImmediate(() => callback());
                }
            });

            await workerManager.getOrCreateWorkerInPool('./examples/scripts/index.js');

            expect(workerManager.lastWorkerRequestTime).toBeGreaterThanOrEqual(beforeTime);
        });

        test('should start pool watcher on first call', async () => {
            const poolWatcherSpy = jest.spyOn(workerManager, 'poolWatcher').mockImplementation();

            // Mock successful worker creation
            mockWorker.on.mockImplementation((event, callback) => {
                if (event === 'online') {
                    setImmediate(() => callback());
                }
            });

            expect(workerManager.watcherStarted).toBe(false);

            await workerManager.getOrCreateWorkerInPool('./examples/scripts/index.js');

            expect(workerManager.watcherStarted).toBe(true);
            expect(poolWatcherSpy).toHaveBeenCalled();

            poolWatcherSpy.mockRestore();
        });

        test('should not start pool watcher if already started', async () => {
            workerManager.watcherStarted = true;
            const poolWatcherSpy = jest.spyOn(workerManager, 'poolWatcher').mockImplementation();

            // Mock successful worker creation
            mockWorker.on.mockImplementation((event, callback) => {
                if (event === 'online') {
                    setImmediate(() => callback());
                }
            });

            await workerManager.getOrCreateWorkerInPool('./examples/scripts/index.js');

            expect(poolWatcherSpy).not.toHaveBeenCalled();

            poolWatcherSpy.mockRestore();
        });

        test('should create new worker when pool is not full', async () => {
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

            // Mock successful worker creation
            mockWorker.on.mockImplementation((event, callback) => {
                if (event === 'online') {
                    setImmediate(() => callback());
                }
            });

            const result = await workerManager.getOrCreateWorkerInPool('./examples/scripts/index.js');

            expect(Worker).toHaveBeenCalledWith('./examples/scripts/index.js', {
                workerData: { port: 8080, name: expect.stringContaining('worker-8080-') },
                resourceLimits: {
                    maxOldGenerationSizeMb: 100,
                    maxYoungGenerationSizeMb: 50
                }
            });
            expect(result.name).toMatch(/worker-8080-\d+/);
            expect(result.port).toBe(8080);
            expect(result.worker).toBe(mockWorker);
            expect(result.createdAt).toEqual(expect.any(Number));
            expect(result.lastUsed).toEqual(expect.any(Number));
            expect(workerManager.workerPool).toHaveLength(1);
            expect(consoleSpy).toHaveBeenCalledWith(expect.stringMatching(/Started worker: worker-8080-\d+ \(port 8080\)/));

            consoleSpy.mockRestore();
        });

        test('should return random worker from pool when pool is full', async () => {
            // Fill the pool to max capacity
            workerManager.workerPool = [
                { name: 'worker-1', port: 8001, worker: { threadId: 1 } },
                { name: 'worker-2', port: 8002, worker: { threadId: 2 } },
                { name: 'worker-3', port: 8003, worker: { threadId: 3 } }
            ];

            // Mock Date.now to control round-robin selection
            const originalDateNow = Date.now;
            Date.now = jest.fn().mockReturnValue(2000); // Should select index 2000 % 3 = 2

            const result = await workerManager.getOrCreateWorkerInPool('./examples/scripts/index.js');

            expect(result).toBe(workerManager.workerPool[2]);
            expect(Worker).not.toHaveBeenCalled();

            Date.now = originalDateNow;
        });

        test('should throw error if worker creation fails and pool is empty', async () => {
            // Mock worker creation failure
            mockWorker.on.mockImplementation((event, callback) => {
                if (event === 'error') {
                    setImmediate(() => callback(new Error('Worker creation failed')));
                }
            });

            const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();

            await expect(workerManager.getOrCreateWorkerInPool('./examples/scripts/index.js'))
                .rejects.toThrow('No workers available in pool');

            expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to create new worker'));
            consoleWarnSpy.mockRestore();
        });

        test('should return existing worker if creation fails but pool has workers', async () => {
            // Add existing worker to pool
            workerManager.workerPool = [
                { name: 'existing-worker', port: 8001, worker: { threadId: 123 } }
            ];

            // Mock worker creation failure
            mockWorker.on.mockImplementation((event, callback) => {
                if (event === 'error') {
                    setImmediate(() => callback(new Error('Worker creation failed')));
                }
            });

            const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();

            const result = await workerManager.getOrCreateWorkerInPool('./examples/scripts/index.js');

            expect(result.name).toBe('existing-worker');
            expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to create new worker'));

            consoleWarnSpy.mockRestore();
        });

        test('should throw error if no workers available', async () => {
            // Force pool to be full by setting maxPoolSize to 0
            workerManager.maxPoolSize = 0;

            await expect(workerManager.getOrCreateWorkerInPool('./examples/scripts/index.js'))
                .rejects.toThrow('No workers available in pool');
        });

        test('should throw error if script path is not provided', async () => {
            await expect(workerManager.getOrCreateWorkerInPool())
                .rejects.toThrow('Script path is required');
        });

        test('should throw error if shutting down', async () => {
            workerManager.isShuttingDown = true;

            await expect(workerManager.getOrCreateWorkerInPool('./examples/scripts/index.js'))
                .rejects.toThrow('WorkerManager is shutting down');
        });
    });

    describe('createWorker', () => {
        test('should create worker with correct parameters', async () => {
            // Mock worker online event to ensure promise resolves and timer is cleared
            mockWorker.on.mockImplementation((event, callback) => {
                if (event === 'online') {
                    setImmediate(() => callback());
                }
            });

            await workerManager.createWorker('./examples/scripts/index.js', 8080, 'test-worker');

            expect(Worker).toHaveBeenCalledWith('./examples/scripts/index.js', {
                workerData: { port: 8080, name: 'test-worker' },
                resourceLimits: {
                    maxOldGenerationSizeMb: 100,
                    maxYoungGenerationSizeMb: 50
                }
            });
        });

        test('should resolve when worker comes online', async () => {
            // Mock worker online event
            mockWorker.on.mockImplementation((event, callback) => {
                if (event === 'online') {
                    setImmediate(() => callback());
                }
            });

            const result = await workerManager.createWorker('./examples/scripts/index.js', 8080, 'test-worker');

            expect(result).toEqual({
                name: 'test-worker',
                port: 8080,
                worker: mockWorker,
                createdAt: expect.any(Number),
                lastUsed: expect.any(Number)
            });
        });

        test('should reject when worker has error', async () => {
            // Mock worker error event
            mockWorker.on.mockImplementation((event, callback) => {
                if (event === 'error') {
                    setImmediate(() => callback(new Error('Worker error')));
                }
            });

            await expect(workerManager.createWorker('./examples/scripts/index.js', 8080, 'test-worker'))
                .rejects.toThrow('Worker error');
        });

        test('should handle worker messages', async () => {
            const loggerInfoSpy = jest.spyOn(logger, 'info').mockImplementation();

            // Mock worker events - store callbacks to trigger them in order
            let onlineCallback, messageCallback;
            mockWorker.on.mockImplementation((event, callback) => {
                if (event === 'online') {
                    onlineCallback = callback;
                } else if (event === 'message') {
                    messageCallback = callback;
                }
            });

            const createWorkerPromise = workerManager.createWorker('./examples/scripts/index.js', 8080, 'test-worker');

            // Trigger online first
            setImmediate(() => onlineCallback());

            await createWorkerPromise;

            // Then trigger message
            setImmediate(() => messageCallback('Test message'));

            // Wait for message to be processed
            await new Promise(resolve => setImmediate(resolve));

            expect(loggerInfoSpy).toHaveBeenCalledWith('worker test-worker message:', 'Test message');

            loggerInfoSpy.mockRestore();
        });

        test('should handle worker errors after creation', async () => {
            const loggerErrorSpy = jest.spyOn(logger, 'error').mockImplementation();

            // Mock worker events - store callbacks
            let onlineCallback, errorCallback;
            mockWorker.on.mockImplementation((event, callback) => {
                if (event === 'online') {
                    onlineCallback = callback;
                } else if (event === 'error') {
                    errorCallback = callback;
                }
            });

            const createWorkerPromise = workerManager.createWorker('./examples/scripts/index.js', 8080, 'test-worker');

            // Trigger online first
            setImmediate(() => onlineCallback());

            await createWorkerPromise;

            // Then trigger error
            const runtimeError = new Error('Runtime error');
            setImmediate(() => errorCallback(runtimeError));

            // Wait for error to be processed
            await new Promise(resolve => setImmediate(resolve));

            expect(loggerErrorSpy).toHaveBeenCalledWith(
                'worker test-worker error:',
                runtimeError
            );

            loggerErrorSpy.mockRestore();
        });

        test('should remove worker from pool when it exits', async () => {
            const loggerInfoSpy = jest.spyOn(logger, 'info').mockImplementation();

            // Add worker to pool first
            workerManager.workerPool = [
                { name: 'test-worker', port: 8080, worker: mockWorker }
            ];

            // Mock worker events - store callbacks
            let onlineCallback, exitCallback;
            mockWorker.on.mockImplementation((event, callback) => {
                if (event === 'online') {
                    onlineCallback = callback;
                } else if (event === 'exit') {
                    exitCallback = callback;
                }
            });

            const createWorkerPromise = workerManager.createWorker('./examples/scripts/index.js', 8080, 'test-worker');

            // Trigger online first
            setImmediate(() => onlineCallback());

            await createWorkerPromise;

            // Then trigger exit
            setImmediate(() => exitCallback(0));

            // Wait for exit to be processed
            await new Promise(resolve => setImmediate(resolve));

            expect(loggerInfoSpy).toHaveBeenCalledWith('worker test-worker exited with code 0');
            expect(loggerInfoSpy).toHaveBeenCalledWith('worker test-worker removed from pool');
            expect(workerManager.workerPool).toHaveLength(0);

            loggerInfoSpy.mockRestore();
        });
    });

    describe('getPoolInfo', () => {
        test('should return correct pool information', () => {
            workerManager.workerPool = [
                { name: 'worker-1', port: 8001, worker: {} },
                { name: 'worker-2', port: 8002, worker: {} }
            ];

            const info = workerManager.getPoolInfo();

            expect(info).toEqual({
                poolSize: 2,
                maxPoolSize: 3,
                isShuttingDown: false,
                watcherStarted: false,
                workers: [
                    { name: 'worker-1', port: 8001, createdAt: undefined, lastUsed: undefined, alive: true },
                    { name: 'worker-2', port: 8002, createdAt: undefined, lastUsed: undefined, alive: true }
                ],
                metrics: expect.any(Object)
            });
        });

        test('should return empty workers array when pool is empty', () => {
            const info = workerManager.getPoolInfo();

            expect(info).toEqual({
                poolSize: 0,
                maxPoolSize: 3,
                isShuttingDown: false,
                watcherStarted: false,
                workers: [],
                metrics: expect.any(Object)
            });
        });
    });

    describe('clearPool', () => {
        test('should clear the pool and update request time', () => {
            workerManager.workerPool = [
                { name: 'worker-1', port: 8001, worker: {} }
            ];

            const beforeTime = Date.now();
            workerManager.clearPool();
            const afterTime = Date.now();

            expect(workerManager.workerPool).toEqual([]);
            expect(workerManager.lastWorkerRequestTime).toBeGreaterThanOrEqual(beforeTime);
            expect(workerManager.lastWorkerRequestTime).toBeLessThanOrEqual(afterTime);
        });
    });

    describe('stopAllWorkers', () => {
        test('should terminate all workers and clear pool', async () => {
            const mockWorker1 = { terminate: jest.fn().mockResolvedValue(undefined) };
            const mockWorker2 = { terminate: jest.fn().mockResolvedValue(undefined) };

            workerManager.workerPool = [
                { name: 'worker-1', port: 8001, worker: mockWorker1 },
                { name: 'worker-2', port: 8002, worker: mockWorker2 }
            ];

            const loggerInfoSpy = jest.spyOn(logger, 'info').mockImplementation();
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

            await workerManager.stopAllWorkers();

            expect(mockWorker1.terminate).toHaveBeenCalled();
            expect(mockWorker2.terminate).toHaveBeenCalled();
            expect(loggerInfoSpy).toHaveBeenCalledWith('Stopping 2 workers...');
            expect(consoleSpy).toHaveBeenCalledWith('Stopped and removed worker: worker-1');
            expect(consoleSpy).toHaveBeenCalledWith('Stopped and removed worker: worker-2');
            expect(loggerInfoSpy).toHaveBeenCalledWith('All workers stopped');
            expect(workerManager.workerPool).toEqual([]);

            loggerInfoSpy.mockRestore();
            consoleSpy.mockRestore();
        });

        test('should handle worker termination errors', async () => {
            const mockWorker1 = {
                terminate: jest.fn().mockRejectedValue(new Error('Termination failed'))
            };

            workerManager.workerPool = [
                { name: 'worker-1', port: 8001, worker: mockWorker1 }
            ];

            const loggerErrorSpy = jest.spyOn(logger, 'error').mockImplementation();

            await workerManager.stopAllWorkers();

            expect(loggerErrorSpy).toHaveBeenCalledWith(
                'Error stopping worker worker-1:',
                'Termination failed'
            );
            expect(workerManager.workerPool).toEqual([]);

            loggerErrorSpy.mockRestore();
        });

        test('should work with empty pool', async () => {
            workerManager.workerPool = [];

            await expect(workerManager.stopAllWorkers()).resolves.not.toThrow();
            expect(workerManager.workerPool).toEqual([]);
        });
    });

    describe('shutdown', () => {
        test('should shutdown gracefully', async () => {
            const loggerInfoSpy = jest.spyOn(logger, 'info').mockImplementation();
            workerManager.watcherInterval = 'mock-interval';
            global.clearInterval = jest.fn();
            jest.spyOn(workerManager, 'stopAllWorkers').mockResolvedValue();

            await workerManager.shutdown();

            expect(workerManager.isShuttingDown).toBe(true);
            expect(global.clearInterval).toHaveBeenCalledWith('mock-interval');
            expect(workerManager.stopAllWorkers).toHaveBeenCalled();
            expect(process.removeAllListeners).toHaveBeenCalledWith('SIGINT');
            expect(process.removeAllListeners).toHaveBeenCalledWith('SIGTERM');
            expect(process.removeAllListeners).toHaveBeenCalledWith('beforeExit');
            expect(loggerInfoSpy).toHaveBeenCalledWith('WorkerManager shutting down...');
            expect(loggerInfoSpy).toHaveBeenCalledWith('WorkerManager shutdown complete');

            loggerInfoSpy.mockRestore();
        });

        test('should not shutdown twice', async () => {
            workerManager.isShuttingDown = true;
            jest.spyOn(workerManager, 'stopAllWorkers').mockResolvedValue();

            await workerManager.shutdown();

            expect(workerManager.stopAllWorkers).not.toHaveBeenCalled();
        });
    });

    describe('healthCheck', () => {
        test('should remove dead workers', async () => {
            const deadWorker = { worker: { threadId: null }, name: 'dead-worker' };
            const aliveWorker = { worker: { threadId: 123 }, name: 'alive-worker' };

            workerManager.workerPool = [aliveWorker, deadWorker];
            const loggerSpy = jest.spyOn(require('../lib/utils/logger'), 'info');

            const result = await workerManager.healthCheck();

            expect(workerManager.workerPool).toEqual([aliveWorker]);
            expect(result).toEqual({
                totalWorkers: 1,
                deadWorkersRemoved: 1,
                healthy: true
            });
            expect(loggerSpy).toHaveBeenCalledWith('Removed 1 dead workers from pool');

            loggerSpy.mockRestore();
        });

        test('should report healthy when workers exist', async () => {
            workerManager.workerPool = [{ worker: { threadId: 123 } }];

            const result = await workerManager.healthCheck();

            expect(result.healthy).toBe(true);
        });

        test('should report unhealthy when shutting down with no workers', async () => {
            workerManager.isShuttingDown = true;
            workerManager.workerPool = [];

            const result = await workerManager.healthCheck();

            expect(result.healthy).toBe(false);
        });
    });

    describe('terminateWorker', () => {
        test('should terminate worker with timeout', async () => {
            const workerInfo = { name: 'test-worker', worker: mockWorker };
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

            await workerManager.terminateWorker(workerInfo);

            expect(mockWorker.terminate).toHaveBeenCalled();
            expect(consoleSpy).toHaveBeenCalledWith('Stopped and removed worker: test-worker');

            consoleSpy.mockRestore();
        });

        test('should force kill worker if termination times out', async () => {
            const workerInfo = { name: 'test-worker', worker: mockWorker };
            // Mock terminate to hang indefinitely
            mockWorker.terminate.mockImplementation(() => new Promise(() => { }));

            const loggerErrorSpy = jest.spyOn(logger, 'error').mockImplementation();

            // Use fake timers to control the timeout
            jest.useFakeTimers();

            const terminatePromise = workerManager.terminateWorker(workerInfo);

            // Fast-forward past the shutdownTimeout (5000ms)
            jest.advanceTimersByTime(5100);

            await terminatePromise;

            expect(mockWorker.kill).toHaveBeenCalled();
            expect(loggerErrorSpy).toHaveBeenCalledWith(
                'Error stopping worker test-worker:',
                'Worker termination timeout'
            );

            loggerErrorSpy.mockRestore();
            jest.useRealTimers();
        });
    });

    describe('removeWorkerFromPool', () => {
        test('should remove worker by name', () => {
            workerManager.workerPool = [
                { name: 'worker-1', worker: {} },
                { name: 'worker-2', worker: {} }
            ];
            const loggerSpy = jest.spyOn(require('../lib/utils/logger'), 'info');

            const removed = workerManager.removeWorkerFromPool('worker-1');

            expect(workerManager.workerPool).toHaveLength(1);
            expect(workerManager.workerPool[0].name).toBe('worker-2');
            expect(removed.name).toBe('worker-1');
            expect(loggerSpy).toHaveBeenCalledWith('worker worker-1 removed from pool');

            loggerSpy.mockRestore();
        });

        test('should return null if worker not found', () => {
            workerManager.workerPool = [{ name: 'worker-1', worker: {} }];

            const removed = workerManager.removeWorkerFromPool('non-existent');

            expect(removed).toBeNull();
            expect(workerManager.workerPool).toHaveLength(1);
        });
    });

    describe('createWorker timeout handling', () => {
        test('should timeout worker creation', async () => {
            // Mock a worker that never comes online
            mockWorker.on.mockImplementation(() => { });

            // Use fake timers to control the timeout
            jest.useFakeTimers();

            const createPromise = workerManager.createWorker('./examples/scripts/index.js', 8080, 'test-worker');

            // Fast-forward past the workerTimeout (30000ms)
            jest.advanceTimersByTime(30100);

            await expect(createPromise).rejects.toThrow('Worker creation timeout after 30000ms');

            jest.useRealTimers();
        });

        test('should handle worker creation errors', async () => {
            Worker.mockImplementation(() => {
                throw new Error('Worker creation failed');
            });

            await expect(workerManager.createWorker('./examples/scripts/index.js', 8080, 'test-worker'))
                .rejects.toThrow('Worker creation failed');
        });
    });
});