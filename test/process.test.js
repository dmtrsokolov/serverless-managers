const ProcessManager = require('../lib/managers/process');
const { getAvailablePort } = require('../lib/utils/port');
const { spawn } = require('child_process');

// Mock dependencies
jest.mock('child_process');
jest.mock('../lib/utils/port');

describe('ProcessManager', () => {
    let processManager;
    let mockChildProcess;

    beforeEach(() => {
        jest.setTimeout(60000);
        // Reset all mocks
        jest.clearAllMocks();

        // Mock child process
        mockChildProcess = {
            stdout: { on: jest.fn(), once: jest.fn() },
            stderr: { on: jest.fn() },
            on: jest.fn(),
            once: jest.fn(),
            kill: jest.fn(),
            killed: false
        };

        spawn.mockReturnValue(mockChildProcess);
        getAvailablePort.mockResolvedValue(9000);

        // Mock process event listeners
        process.once = jest.fn();
        process.removeAllListeners = jest.fn();

        // Create fresh instance
        processManager = new ProcessManager();
    });

    afterEach(() => {
        // Clean up any intervals to prevent timer leaks
        if (processManager) {
            processManager.stopPoolWatcher();
            processManager.isShuttingDown = false; // Reset for next test
        }
        jest.clearAllTimers();
    });

    describe('constructor', () => {
        test('should initialize with default options', () => {
            expect(processManager.maxPoolSize).toBe(3);
            expect(processManager.poolCheckInterval).toBe(10000);
            expect(processManager.processTimeout).toBe(30000);
            expect(processManager.shutdownTimeout).toBe(5000);
            expect(processManager.processPool).toEqual([]);
            expect(processManager.watcherStarted).toBe(false);
            expect(processManager.isShuttingDown).toBe(false);
            expect(process.once).toHaveBeenCalledTimes(3);
        });

        test('should initialize with custom options', () => {
            const customManager = new ProcessManager({
                maxPoolSize: 5,
                poolCheckInterval: 5000,
                processTimeout: 15000,
                shutdownTimeout: 3000
            });

            expect(customManager.maxPoolSize).toBe(5);
            expect(customManager.poolCheckInterval).toBe(5000);
            expect(customManager.processTimeout).toBe(15000);
            expect(customManager.shutdownTimeout).toBe(3000);
        });

        test('should set lastProcessRequestTime on initialization', () => {
            const beforeTime = Date.now();
            const manager = new ProcessManager();
            const afterTime = Date.now();

            expect(manager.lastProcessRequestTime).toBeGreaterThanOrEqual(beforeTime);
            expect(manager.lastProcessRequestTime).toBeLessThanOrEqual(afterTime);
        });
    });

    describe('createProcess', () => {
        test('should create a new process successfully', async () => {
            const scriptPath = './test-script.js';
            const port = 9000;
            const processName = 'test-process';

            // Mock stdout.once event
            mockChildProcess.stdout.once.mockImplementation((event, callback) => {
                if (event === 'data') {
                    setImmediate(() => callback('Server started'));
                }
            });

            const result = await processManager.createProcess(scriptPath, port, processName);

            expect(spawn).toHaveBeenCalledWith('node', [scriptPath, port]);
            expect(result).toEqual({
                name: processName,
                port: port,
                process: mockChildProcess,
                createdAt: expect.any(Number),
                lastUsed: expect.any(Number)
            });
        });

        test('should handle process creation error', async () => {
            const scriptPath = './test-script.js';
            const port = 9000;
            const processName = 'test-process';

            // Mock process error event
            mockChildProcess.on.mockImplementation((event, callback) => {
                if (event === 'error') {
                    setImmediate(() => callback(new Error('Process failed to start')));
                }
            });

            await expect(processManager.createProcess(scriptPath, port, processName))
                .rejects.toThrow('Process failed to start');
        });

        test('should handle process close event', async () => {
            const scriptPath = './test-script.js';
            const port = 9000;
            const processName = 'test-process';

            const loggerSpy = jest.spyOn(require('../lib/utils/logger'), 'info');

            // Mock stdout.once and on events
            let closeCallback;
            mockChildProcess.stdout.once.mockImplementation((event, callback) => {
                if (event === 'data') {
                    setImmediate(() => callback('Server started'));
                }
            });
            mockChildProcess.on.mockImplementation((event, callback) => {
                if (event === 'close') {
                    closeCallback = callback;
                }
            });

            const processInfo = await processManager.createProcess(scriptPath, port, processName);
            processManager.processPool.push(processInfo);

            // Trigger close event
            setImmediate(() => closeCallback(0));

            // Wait for close to be processed
            await new Promise(resolve => setImmediate(resolve));

            // Process should be removed from pool
            expect(processManager.processPool).toHaveLength(0);
            expect(loggerSpy).toHaveBeenCalledWith(`${processName} exited with code 0`);

            loggerSpy.mockRestore();
        });

        test('should handle process errors after creation', async () => {
            const scriptPath = './test-script.js';
            const port = 9000;
            const processName = 'test-process';

            const loggerSpy = jest.spyOn(require('../lib/utils/logger'), 'error');

            // Mock events
            let errorCallback;
            mockChildProcess.stdout.once.mockImplementation((event, callback) => {
                if (event === 'data') {
                    setImmediate(() => callback('Server started'));
                }
            });
            mockChildProcess.on.mockImplementation((event, callback) => {
                if (event === 'error') {
                    errorCallback = callback;
                }
            });

            const processInfo = await processManager.createProcess(scriptPath, port, processName);
            processManager.processPool.push(processInfo);

            // Trigger error after creation
            const runtimeError = new Error('Runtime error');
            setImmediate(() => errorCallback(runtimeError));

            // Wait for error to be processed
            await new Promise(resolve => setImmediate(resolve));

            expect(loggerSpy).toHaveBeenCalledWith(
                `${processName} error:`,
                runtimeError
            );
            expect(processManager.processPool).toHaveLength(0);

            loggerSpy.mockRestore();
        });

        test('should timeout process creation', async () => {
            const scriptPath = './test-script.js';
            const port = 9000;
            const processName = 'test-process';

            // Mock a process that never sends stdout
            mockChildProcess.stdout.once.mockImplementation(() => { });
            mockChildProcess.on.mockImplementation(() => { });

            // Use fake timers
            jest.useFakeTimers();

            const createPromise = processManager.createProcess(scriptPath, port, processName);

            // Fast-forward past the processTimeout (30000ms)
            jest.advanceTimersByTime(30100);

            await expect(createPromise).rejects.toThrow('Process creation timeout after 30000ms');

            jest.useRealTimers();
        });
    });

    describe('getOrCreateProcessInPool', () => {
        test('should create new process when pool is empty', async () => {
            const scriptPath = './test-script.js';
            const loggerSpy = jest.spyOn(require('../lib/utils/logger'), 'info');

            // Mock stdout.once event
            mockChildProcess.stdout.once.mockImplementation((event, callback) => {
                if (event === 'data') {
                    setImmediate(() => callback('Server started'));
                }
            });

            const result = await processManager.getOrCreateProcessInPool(scriptPath);

            expect(result.name).toMatch(/process-9000-\d+/);
            expect(result.port).toBe(9000);
            expect(result.createdAt).toEqual(expect.any(Number));
            expect(result.lastUsed).toEqual(expect.any(Number));
            expect(processManager.processPool).toHaveLength(1);
            expect(loggerSpy).toHaveBeenCalledWith(expect.stringMatching(/Started process: process-9000-\d+ \(port 9000\)/));

            loggerSpy.mockRestore();
        });

        test('should return round-robin process from pool when pool is full', async () => {
            const scriptPath = './test-script.js';

            // Create mock processes with killed: false
            const mockProcess = {
                stdout: { on: jest.fn(), once: jest.fn() },
                stderr: { on: jest.fn() },
                on: jest.fn(),
                once: jest.fn(),
                kill: jest.fn(),
                killed: false
            };

            // Add existing processes to pool
            const existingProcess1 = { name: 'process-8001', port: 8001, process: mockProcess };
            const existingProcess2 = { name: 'process-8002', port: 8002, process: mockProcess };
            const existingProcess3 = { name: 'process-8003', port: 8003, process: mockProcess };
            processManager.processPool = [existingProcess1, existingProcess2, existingProcess3];

            // Mock Date.now to control round-robin selection
            const originalDateNow = Date.now;
            Date.now = jest.fn().mockReturnValue(2000); // Should select index 2000 % 3 = 2

            const result = await processManager.getOrCreateProcessInPool(scriptPath);

            expect(result).toBe(existingProcess3);
            expect(spawn).not.toHaveBeenCalled();

            Date.now = originalDateNow;
        });

        test('should throw error if process creation fails and pool is empty', async () => {
            const scriptPath = './test-script.js';

            // Mock process creation failure
            mockChildProcess.on.mockImplementation((event, callback) => {
                if (event === 'error') {
                    setImmediate(() => callback(new Error('Process creation failed')));
                }
            });

            const loggerSpy = jest.spyOn(require('../lib/utils/logger'), 'warn');

            await expect(processManager.getOrCreateProcessInPool(scriptPath))
                .rejects.toThrow('No processes available in pool');

            expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to create new process'));
            loggerSpy.mockRestore();
        });

        test('should return existing process if creation fails but pool has processes', async () => {
            const mockProcess = {
                stdout: { on: jest.fn(), once: jest.fn() },
                stderr: { on: jest.fn() },
                on: jest.fn(),
                once: jest.fn(),
                kill: jest.fn(),
                killed: false
            };

            // Add existing process to pool
            processManager.processPool = [
                { name: 'existing-process', port: 8001, process: mockProcess }
            ];

            // Mock process creation failure
            mockChildProcess.on.mockImplementation((event, callback) => {
                if (event === 'error') {
                    setImmediate(() => callback(new Error('Process creation failed')));
                }
            });

            const loggerSpy = jest.spyOn(require('../lib/utils/logger'), 'warn');

            const result = await processManager.getOrCreateProcessInPool('./test-script.js');

            expect(result.name).toBe('existing-process');
            expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to create new process'));

            loggerSpy.mockRestore();
        });

        test('should throw error if script path is not provided', async () => {
            await expect(processManager.getOrCreateProcessInPool())
                .rejects.toThrow('Script path is required');
        });

        test('should throw error if shutting down', async () => {
            processManager.isShuttingDown = true;

            await expect(processManager.getOrCreateProcessInPool('./test-script.js'))
                .rejects.toThrow('ProcessManager is shutting down');
        });

        // test('should start watcher on first call', async () => {
        //     const scriptPath = './test-script.js';

        //     // Mock spawn to return a successful process
        //     const mockProcess = {
        //         pid: 12345,
        //         kill: jest.fn(),
        //         on: jest.fn((event, callback) => {
        //             if (event === 'spawn') {
        //                 // Simulate successful spawn
        //                 setTimeout(() => callback(), 0);
        //             }
        //         }),
        //         stdout: { on: jest.fn() },
        //         stderr: { on: jest.fn() }
        //     };

        //     spawn.mockReturnValue(mockProcess);

        //     // Mock getAvailablePort to return a port
        //     getAvailablePort.mockResolvedValue(8001);

        //     jest.spyOn(processManager, 'poolWatcher');

        //     const getPromise = processManager.getOrCreateProcessInPool(scriptPath);

        //     await getPromise;

        //     expect(processManager.poolWatcher).toHaveBeenCalled();
        //     expect(processManager.watcherStarted).toBe(true);
        // });

        // test('should throw error when no processes available', async () => {
        //     const scriptPath = './test-script.js';

        //     // Define mockProcess within this test
        //     const mockProcess = {
        //         pid: 12345,
        //         kill: jest.fn(),
        //         on: jest.fn(),
        //         stdout: { on: jest.fn() },
        //         stderr: { on: jest.fn() }
        //     };

        //     // Set pool to max size with mock processes
        //     processManager.processPool = new Array(3).fill({ name: 'test', port: 8000, process: mockProcess });

        //     // Mock process creation to fail
        //     spawn.mockImplementation(() => {
        //         const failedProcess = {
        //             stdout: { on: jest.fn() },
        //             stderr: { on: jest.fn() },
        //             on: jest.fn(),
        //             kill: jest.fn()
        //         };

        //         // Immediately trigger error
        //         setTimeout(() => {
        //             const errorCallback = failedProcess.on.mock.calls.find(call => call[0] === 'error')[1];
        //             if (errorCallback) errorCallback(new Error('Failed to create'));
        //         }, 0);

        //         return failedProcess;
        //     });

        //     await expect(processManager.getOrCreateProcessInPool(scriptPath))
        //         .rejects.toThrow('No processes available in pool');
        // });
    });

    describe('getPoolInfo', () => {
        test('should return pool information', () => {
            // Create a mock process object
            const mockProcess = {
                pid: 12345,
                kill: jest.fn(),
                on: jest.fn(),
                killed: false
            };

            const process1 = { name: 'process-8001', port: 8001, process: mockProcess };
            const process2 = { name: 'process-8002', port: 8002, process: mockProcess };
            processManager.processPool = [process1, process2];

            const info = processManager.getPoolInfo();

            expect(info).toEqual({
                poolSize: 2,
                maxPoolSize: 3,
                isShuttingDown: false,
                watcherStarted: false,
                processes: [
                    { name: 'process-8001', port: 8001, createdAt: undefined, lastUsed: undefined, alive: true },
                    { name: 'process-8002', port: 8002, createdAt: undefined, lastUsed: undefined, alive: true }
                ],
                metrics: expect.any(Object)
            });
        });

        test('should return empty processes array when pool is empty', () => {
            const info = processManager.getPoolInfo();

            expect(info).toEqual({
                poolSize: 0,
                maxPoolSize: 3,
                isShuttingDown: false,
                watcherStarted: false,
                processes: [],
                metrics: expect.any(Object)
            });
        });
    });

    describe('clearPool', () => {
        test('should clear the process pool', () => {
            // Create a mock process object
            const mockProcess = {
                pid: 12345,
                kill: jest.fn(),
                on: jest.fn(),
            };

            // Add processes to the pool
            const process1 = { name: 'process-8001', port: 8001, process: mockProcess };
            const process2 = { name: 'process-8002', port: 8002, process: mockProcess };
            processManager.processPool = [process1, process2];

            // Clear the pool
            processManager.clearPool();

            // Verify pool is empty
            expect(processManager.processPool).toEqual([]);
        });
    });

    describe('stopAllProcesses', () => {
        test('should stop all processes in pool', async () => {
            const mockProcess1 = { kill: jest.fn(), once: jest.fn((event, cb) => setImmediate(cb)) };
            const mockProcess2 = { kill: jest.fn(), once: jest.fn((event, cb) => setImmediate(cb)) };

            processManager.processPool = [
                { name: 'process-1', port: 8001, process: mockProcess1 },
                { name: 'process-2', port: 8002, process: mockProcess2 }
            ];

            const loggerSpy = jest.spyOn(require('../lib/utils/logger'), 'info');

            await processManager.stopAllProcesses();

            expect(mockProcess1.kill).toHaveBeenCalled();
            expect(mockProcess2.kill).toHaveBeenCalled();
            expect(loggerSpy).toHaveBeenCalledWith('Stopping 2 processes...');
            expect(loggerSpy).toHaveBeenCalledWith('Stopped and removed process: process-1');
            expect(loggerSpy).toHaveBeenCalledWith('Stopped and removed process: process-2');
            expect(loggerSpy).toHaveBeenCalledWith('All processes stopped');
            expect(processManager.processPool).toEqual([]);

            loggerSpy.mockRestore();
        });

        test('should handle errors when stopping processes', async () => {
            const mockProcess = {
                kill: jest.fn().mockImplementation(() => {
                    throw new Error('Failed to kill');
                }),
                once: jest.fn()
            };

            processManager.processPool = [
                { name: 'process-1', port: 8001, process: mockProcess }
            ];

            const loggerSpy = jest.spyOn(require('../lib/utils/logger'), 'error');

            await processManager.stopAllProcesses();

            expect(loggerSpy).toHaveBeenCalledWith(
                'Error stopping process process-1:',
                'Failed to kill'
            );
            expect(processManager.processPool).toEqual([]);

            loggerSpy.mockRestore();
        });

        test('should work with empty pool', async () => {
            processManager.processPool = [];

            await expect(processManager.stopAllProcesses()).resolves.not.toThrow();
            expect(processManager.processPool).toEqual([]);
        });
    });

    describe('poolWatcher', () => {
        test('should set up interval for pool watching', () => {
            const originalSetInterval = global.setInterval;
            global.setInterval = jest.fn();

            processManager.poolWatcher();

            expect(global.setInterval).toHaveBeenCalledWith(
                expect.any(Function),
                processManager.poolCheckInterval
            );

            global.setInterval = originalSetInterval;
        });

        test('should remove process from pool after interval with no requests', async () => {
            const mockProcess = {
                kill: jest.fn(),
                once: jest.fn((event, callback) => {
                    if (event === 'exit') setImmediate(callback);
                })
            };
            processManager.processPool = [
                { name: 'old-process', port: 8001, process: mockProcess }
            ];

            // Set last request time to more than 10 seconds ago
            processManager.lastProcessRequestTime = Date.now() - 11000;

            const loggerSpy = jest.spyOn(require('../lib/utils/logger'), 'info');

            // Mock setInterval to capture and immediately execute the callback
            const originalSetInterval = global.setInterval;
            global.setInterval = jest.fn((callback) => {
                setImmediate(callback);
                return 'mock-timer-id';
            });

            processManager.poolWatcher();

            // Wait for the callback to execute
            await new Promise(resolve => setImmediate(resolve));
            await new Promise(resolve => setImmediate(resolve));

            expect(mockProcess.kill).toHaveBeenCalled();
            expect(processManager.processPool).toHaveLength(0);
            expect(loggerSpy).toHaveBeenCalledWith('Stopped and removed process: old-process');

            loggerSpy.mockRestore();
            global.setInterval = originalSetInterval;
        });

        test('should not remove process if recent request exists', async () => {
            const mockProcess = {
                kill: jest.fn(),
                once: jest.fn()
            };
            processManager.processPool = [
                { name: 'recent-process', port: 8001, process: mockProcess }
            ];

            // Set recent request time
            processManager.lastProcessRequestTime = Date.now();

            // Mock setInterval to capture and immediately execute the callback
            const originalSetInterval = global.setInterval;
            global.setInterval = jest.fn((callback) => {
                setImmediate(callback);
                return 'mock-timer-id';
            });

            processManager.poolWatcher();

            // Wait for the callback to execute
            await new Promise(resolve => setImmediate(resolve));

            expect(mockProcess.kill).not.toHaveBeenCalled();
            expect(processManager.processPool).toHaveLength(1);

            global.setInterval = originalSetInterval;
        });

        test('should not do anything if pool is empty', async () => {
            processManager.processPool = [];
            processManager.lastProcessRequestTime = Date.now() - 15000;

            const originalSetInterval = global.setInterval;
            global.setInterval = jest.fn((callback) => {
                setImmediate(callback);
                return 'mock-timer-id';
            });

            processManager.poolWatcher();

            await new Promise(resolve => setImmediate(resolve));

            expect(processManager.processPool).toHaveLength(0);

            global.setInterval = originalSetInterval;
        });
    });

    describe('shutdown', () => {
        test('should shutdown gracefully', async () => {
            const loggerSpy = jest.spyOn(require('../lib/utils/logger'), 'info');
            processManager.watcherInterval = 'mock-interval';
            global.clearInterval = jest.fn();
            jest.spyOn(processManager, 'stopAllProcesses').mockResolvedValue();

            await processManager.shutdown();

            expect(processManager.isShuttingDown).toBe(true);
            expect(global.clearInterval).toHaveBeenCalledWith('mock-interval');
            expect(processManager.stopAllProcesses).toHaveBeenCalled();
            expect(process.removeAllListeners).toHaveBeenCalledWith('SIGINT');
            expect(process.removeAllListeners).toHaveBeenCalledWith('SIGTERM');
            expect(process.removeAllListeners).toHaveBeenCalledWith('beforeExit');
            expect(loggerSpy).toHaveBeenCalledWith('ProcessManager shutting down...');
            expect(loggerSpy).toHaveBeenCalledWith('ProcessManager shutdown complete');

            loggerSpy.mockRestore();
        });

        test('should not shutdown twice', async () => {
            processManager.isShuttingDown = true;
            jest.spyOn(processManager, 'stopAllProcesses').mockResolvedValue();

            await processManager.shutdown();

            expect(processManager.stopAllProcesses).not.toHaveBeenCalled();
        });
    });

    describe('healthCheck', () => {
        test('should remove dead processes', async () => {
            const deadProcess = { process: { killed: true }, name: 'dead-process' };
            const aliveProcess = { process: { killed: false }, name: 'alive-process' };

            processManager.processPool = [aliveProcess, deadProcess];
            const loggerSpy = jest.spyOn(require('../lib/utils/logger'), 'info');

            const result = await processManager.healthCheck();

            expect(processManager.processPool).toEqual([aliveProcess]);
            expect(result).toEqual({
                totalProcesses: 1,
                deadProcessesRemoved: 1,
                healthy: true
            });
            expect(loggerSpy).toHaveBeenCalledWith('Removed 1 dead processes from pool');

            loggerSpy.mockRestore();
        });

        test('should report healthy when processes exist', async () => {
            processManager.processPool = [{ process: { killed: false } }];

            const result = await processManager.healthCheck();

            expect(result.healthy).toBe(true);
        });

        test('should report unhealthy when shutting down with no processes', async () => {
            processManager.isShuttingDown = true;
            processManager.processPool = [];

            const result = await processManager.healthCheck();

            expect(result.healthy).toBe(false);
        });
    });

    describe('terminateProcess', () => {
        test('should terminate process with timeout', async () => {
            const mockProcess = {
                kill: jest.fn(),
                once: jest.fn((event, callback) => {
                    if (event === 'exit') setImmediate(callback);
                })
            };
            const processInfo = { name: 'test-process', process: mockProcess };
            const loggerSpy = jest.spyOn(require('../lib/utils/logger'), 'info').mockImplementation();

            await processManager.terminateProcess(processInfo);

            expect(mockProcess.kill).toHaveBeenCalled();
            expect(loggerSpy).toHaveBeenCalledWith('Stopped and removed process: test-process');

            loggerSpy.mockRestore();
        });

        test('should force kill process if termination times out', async () => {
            const mockProcess = {
                kill: jest.fn().mockImplementation((signal) => {
                    if (signal === 'SIGKILL') return;
                    // Regular kill hangs
                    return new Promise(() => { });
                }),
                once: jest.fn()
            };
            const processInfo = { name: 'test-process', process: mockProcess };

            const loggerSpy = jest.spyOn(require('../lib/utils/logger'), 'error');

            // Use fake timers
            jest.useFakeTimers();

            const terminatePromise = processManager.terminateProcess(processInfo);

            // Fast-forward past the shutdownTimeout (5000ms)
            jest.advanceTimersByTime(5100);

            await terminatePromise;

            expect(mockProcess.kill).toHaveBeenCalledWith('SIGKILL');
            expect(loggerSpy).toHaveBeenCalledWith(
                'Error stopping process test-process:',
                'Process termination timeout'
            );

            loggerSpy.mockRestore();
            jest.useRealTimers();
        });
    });

    describe('removeProcessFromPool', () => {
        test('should remove process by name', () => {
            processManager.processPool = [
                { name: 'process-1', process: {} },
                { name: 'process-2', process: {} }
            ];
            const loggerSpy = jest.spyOn(require('../lib/utils/logger'), 'info');

            const removed = processManager.removeProcessFromPool('process-1');

            expect(processManager.processPool).toHaveLength(1);
            expect(processManager.processPool[0].name).toBe('process-2');
            expect(removed.name).toBe('process-1');
            expect(loggerSpy).toHaveBeenCalledWith('process process-1 removed from pool');

            loggerSpy.mockRestore();
        });

        test('should return null if process not found', () => {
            processManager.processPool = [{ name: 'process-1', process: {} }];

            const removed = processManager.removeProcessFromPool('non-existent');

            expect(removed).toBeNull();
            expect(processManager.processPool).toHaveLength(1);
        });
    });
});