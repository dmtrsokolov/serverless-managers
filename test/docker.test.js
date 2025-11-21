const DockerManager = require('../lib/managers/docker');
const { getAvailablePort } = require('../lib/utils/port');
const Docker = require('dockerode');

// Mock dependencies
jest.mock('dockerode');
jest.mock('../lib/utils/port');

describe('DockerManager', () => {
    let dockerManager;
    let mockDocker;
    let mockContainer;

    beforeEach(() => {
        jest.setTimeout(60000);
        jest.clearAllMocks();
        
        mockContainer = {
            id: 'mock-container-id',
            start: jest.fn().mockResolvedValue(undefined),
            stop: jest.fn().mockResolvedValue(undefined),
            remove: jest.fn().mockResolvedValue(undefined),
            inspect: jest.fn().mockResolvedValue({
                State: { Running: true }
            })
        };

        mockDocker = {
            createContainer: jest.fn().mockResolvedValue(mockContainer),
            getContainer: jest.fn().mockReturnValue(mockContainer)
        };

        Docker.mockImplementation(() => mockDocker);
        getAvailablePort.mockResolvedValue(3000);

        // Mock process event listeners
        process.once = jest.fn();
        process.removeAllListeners = jest.fn();

        dockerManager = new DockerManager();
    });

    afterEach(() => {
        // Clean up any intervals to prevent timer leaks
        if (dockerManager) {
            dockerManager.stopPoolWatcher();
            dockerManager.isShuttingDown = false; // Reset for next test
        }
        jest.clearAllTimers();
    });

    describe('constructor', () => {
        test('should initialize with default options', () => {
            expect(dockerManager.defaultContainerName).toBe('my-nodejs-express');
            expect(dockerManager.defaultImageName).toBe('my-nodejs-express');
            expect(dockerManager.maxPoolSize).toBe(3);
            expect(dockerManager.poolCheckInterval).toBe(10000);
            expect(dockerManager.containerTimeout).toBe(30000);
            expect(dockerManager.shutdownTimeout).toBe(10000);
            expect(dockerManager.containerPool).toEqual([]);
            expect(dockerManager.watcherStarted).toBe(false);
            expect(dockerManager.isShuttingDown).toBe(false);
            expect(process.once).toHaveBeenCalledTimes(3);
        });

        test('should initialize with custom options', () => {
            const options = {
                defaultContainerName: 'custom-container',
                defaultImageName: 'custom-image',
                maxPoolSize: 5,
                poolCheckInterval: 5000,
                containerTimeout: 15000,
                shutdownTimeout: 8000
            };
            const manager = new DockerManager(options);
            expect(manager.defaultContainerName).toBe('custom-container');
            expect(manager.defaultImageName).toBe('custom-image');
            expect(manager.maxPoolSize).toBe(5);
            expect(manager.poolCheckInterval).toBe(5000);
            expect(manager.containerTimeout).toBe(15000);
            expect(manager.shutdownTimeout).toBe(8000);
        });

        test('should set lastDockerRequestTime on initialization', () => {
            const beforeTime = Date.now();
            const manager = new DockerManager();
            const afterTime = Date.now();
            
            expect(manager.lastDockerRequestTime).toBeGreaterThanOrEqual(beforeTime);
            expect(manager.lastDockerRequestTime).toBeLessThanOrEqual(afterTime);
        });
    });

    describe('createContainer', () => {
        test('should create container successfully', async () => {
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
            
            const result = await dockerManager.createContainer(3000, 'test-container', '/path/to/script', ['index.js']);
            
            expect(mockDocker.createContainer).toHaveBeenCalledWith({
                Image: 'my-nodejs-express',
                name: 'test-container',
                ExposedPorts: { '9000/tcp': {} },
                HostConfig: {
                    PortBindings: { '9000/tcp': [{ HostPort: '3000' }] },
                    Binds: ['/path/to/script/index.js:/usr/src/app/index.js']
                },
                WorkingDir: '/usr/src/app',
                Cmd: ['node', 'index.js', '9000']
            });
            expect(mockContainer.start).toHaveBeenCalled();
            expect(result).toEqual({
                id: 'mock-container-id',
                status: 'started',
                name: 'test-container'
            });
            expect(consoleSpy).toHaveBeenCalledWith('Creating container "test-container" on port 3000');
            
            consoleSpy.mockRestore();
        });

        test('should throw error when scriptDir is not provided', async () => {
            await expect(dockerManager.createContainer(3000, 'test-container'))
                .rejects.toThrow('scriptDir is required to bind the script into the container');
        });

        test('should throw error when scriptFiles is empty', async () => {
            await expect(dockerManager.createContainer(3000, 'test-container', '/path/to/script', []))
                .rejects.toThrow('At least one script file must be specified');
        });

        test('should handle multiple script files', async () => {
            await dockerManager.createContainer(3000, 'test-container', '/path/to/script', ['index.js', 'utils.js']);
            
            expect(mockDocker.createContainer).toHaveBeenCalledWith(
                expect.objectContaining({
                    HostConfig: expect.objectContaining({
                        Binds: [
                            '/path/to/script/index.js:/usr/src/app/index.js',
                            '/path/to/script/utils.js:/usr/src/app/utils.js'
                        ]
                    })
                })
            );
        });

        test('should timeout container creation', async () => {
            mockDocker.createContainer.mockImplementation(() => new Promise(() => {})); // Never resolves
            
            jest.useFakeTimers();
            
            const createPromise = dockerManager.createContainer(3000, 'test-container', '/path/to/script', ['index.js']);
            
            jest.advanceTimersByTime(30100);
            
            await expect(createPromise).rejects.toThrow('Container creation timeout after 30000ms');
            
            jest.useRealTimers();
        });

        test('should handle container creation errors', async () => {
            mockDocker.createContainer.mockRejectedValue(new Error('Container creation failed'));
            
            await expect(dockerManager.createContainer(3000, 'test-container', '/path/to/script', ['index.js']))
                .rejects.toThrow('Container creation failed');
        });
    });

    describe('stopContainer', () => {
        test('should stop and remove container successfully', async () => {
            const result = await dockerManager.stopContainer('test-container');
            
            expect(mockDocker.getContainer).toHaveBeenCalledWith('test-container');
            expect(mockContainer.stop).toHaveBeenCalled();
            expect(mockContainer.remove).toHaveBeenCalled();
            expect(result).toEqual({
                status: 'stopped and removed',
                name: 'test-container'
            });
        });

        test('should handle container not found error', async () => {
            const error = new Error('Container not found');
            error.statusCode = 404;
            mockDocker.getContainer.mockImplementation(() => {
                throw error;
            });

            const result = await dockerManager.stopContainer('non-existent');
            expect(result).toEqual({
                status: 'container not found',
                name: 'non-existent'
            });
        });

        test('should ignore already stopped container error', async () => {
            const error = new Error('Container already stopped');
            error.statusCode = 304;
            mockContainer.stop.mockRejectedValue(error);

            const result = await dockerManager.stopContainer('test-container');
            expect(result).toEqual({
                status: 'stopped and removed',
                name: 'test-container'
            });
        });
    });

    describe('getOrCreateContainerInPool', () => {
        test('should create new container when pool is empty', async () => {
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
            
            const result = await dockerManager.getOrCreateContainerInPool('/path/to/script');
            
            expect(getAvailablePort).toHaveBeenCalled();
            expect(mockDocker.createContainer).toHaveBeenCalled();
            expect(dockerManager.containerPool).toHaveLength(1);
            expect(result.name).toMatch(/my-nodejs-express-3000-\d+/);
            expect(result.port).toBe(3000);
            expect(result.id).toBe('mock-container-id');
            expect(result.createdAt).toEqual(expect.any(Number));
            expect(result.lastUsed).toEqual(expect.any(Number));
            
            consoleSpy.mockRestore();
        });

        test('should return round-robin container from pool when pool is full', async () => {
            // Fill the pool to max capacity
            dockerManager.containerPool = [
                { name: 'container-1', port: 8001, id: 'id-1' },
                { name: 'container-2', port: 8002, id: 'id-2' },
                { name: 'container-3', port: 8003, id: 'id-3' }
            ];
            
            // Mock Date.now to control round-robin selection
            const originalDateNow = Date.now;
            Date.now = jest.fn().mockReturnValue(2000); // Should select index 2000 % 3 = 2
            
            const result = await dockerManager.getOrCreateContainerInPool('/path/to/script');
            
            expect(result).toBe(dockerManager.containerPool[2]);
            expect(mockDocker.createContainer).not.toHaveBeenCalled();
            
            Date.now = originalDateNow;
        });

        test('should throw error if container creation fails and pool is empty', async () => {
            mockDocker.createContainer.mockRejectedValue(new Error('Container creation failed'));
            
            const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
            
            await expect(dockerManager.getOrCreateContainerInPool('/path/to/script'))
                .rejects.toThrow('No containers available in pool');
                
            expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to create new container'));
            consoleWarnSpy.mockRestore();
        });

        test('should return existing container if creation fails but pool has containers', async () => {
            // Add existing container to pool
            dockerManager.containerPool = [
                { name: 'existing-container', port: 8001, id: 'existing-id' }
            ];
            
            // Mock container creation failure
            mockDocker.createContainer.mockRejectedValue(new Error('Container creation failed'));
            
            const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
            
            const result = await dockerManager.getOrCreateContainerInPool('/path/to/script');
            
            expect(result.name).toBe('existing-container');
            expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to create new container'));
            
            consoleWarnSpy.mockRestore();
        });

        test('should throw error if script directory path is not provided', async () => {
            await expect(dockerManager.getOrCreateContainerInPool())
                .rejects.toThrow('Script directory path is required');
        });

        test('should throw error if shutting down', async () => {
            dockerManager.isShuttingDown = true;
            
            await expect(dockerManager.getOrCreateContainerInPool('/path/to/script'))
                .rejects.toThrow('DockerManager is shutting down');
        });

        test('should remove dead containers from pool', async () => {
            dockerManager.containerPool = [
                { name: 'dead-container', port: 8001, id: 'dead-id' }
            ];
            
            // Mock inspect to return non-running state
            mockContainer.inspect.mockResolvedValue({ State: { Running: false } });
            
            await dockerManager.getOrCreateContainerInPool('/path/to/script');
            
            // Should create new container since existing one is dead
            expect(mockDocker.createContainer).toHaveBeenCalled();
        });
    });

    describe('getPoolInfo', () => {
        test('should return pool information', () => {
            dockerManager.containerPool = [
                { name: 'container1', port: 3000, id: 'id-1', createdAt: 1234, lastUsed: 5678 },
                { name: 'container2', port: 3001, id: 'id-2', createdAt: 2345, lastUsed: 6789 }
            ];

            const info = dockerManager.getPoolInfo();
            expect(info).toEqual({
                poolSize: 2,
                maxPoolSize: 3,
                isShuttingDown: false,
                watcherStarted: false,
                containers: [
                    { name: 'container1', port: 3000, id: 'id-1', createdAt: 1234, lastUsed: 5678 },
                    { name: 'container2', port: 3001, id: 'id-2', createdAt: 2345, lastUsed: 6789 }
                ]
            });
        });

        test('should return empty containers array when pool is empty', () => {
            const info = dockerManager.getPoolInfo();
            
            expect(info).toEqual({
                poolSize: 0,
                maxPoolSize: 3,
                isShuttingDown: false,
                watcherStarted: false,
                containers: []
            });
        });
    });

    describe('clearPool', () => {
        test('should clear container pool', () => {
            dockerManager.containerPool = [{ name: 'container1', port: 3000 }];
            dockerManager.clearPool();
            
            expect(dockerManager.containerPool).toEqual([]);
            expect(dockerManager.lastDockerRequestTime).toBeDefined();
        });
    });

    describe('stopAllContainers', () => {
        test('should stop all containers in pool', async () => {
            dockerManager.containerPool = [
                { name: 'container1', port: 3000 },
                { name: 'container2', port: 3001 }
            ];

            const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

            await dockerManager.stopAllContainers();

            expect(mockDocker.getContainer).toHaveBeenCalledTimes(2);
            expect(consoleSpy).toHaveBeenCalledWith('Stopping 2 containers...');
            expect(consoleSpy).toHaveBeenCalledWith('Stopped and removed container: container1 (port 3000)');
            expect(consoleSpy).toHaveBeenCalledWith('Stopped and removed container: container2 (port 3001)');
            expect(consoleSpy).toHaveBeenCalledWith('All containers stopped');
            expect(dockerManager.containerPool).toEqual([]);
            
            consoleSpy.mockRestore();
        });

        test('should handle errors when stopping containers', async () => {
            const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
            mockContainer.stop.mockRejectedValue(new Error('Stop failed'));
            dockerManager.containerPool = [{ name: 'container1', port: 3000 }];

            await dockerManager.stopAllContainers();

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                'Error stopping container container1:',
                'Stop failed'
            );
            expect(dockerManager.containerPool).toEqual([]);
            
            consoleErrorSpy.mockRestore();
        });

        test('should work with empty pool', async () => {
            dockerManager.containerPool = [];
            
            await expect(dockerManager.stopAllContainers()).resolves.not.toThrow();
            expect(dockerManager.containerPool).toEqual([]);
        });
    });

    describe('poolWatcher', () => {
        test('should set up interval for pool watching', () => {
            const originalSetInterval = global.setInterval;
            global.setInterval = jest.fn();
            
            dockerManager.poolWatcher();
            
            expect(global.setInterval).toHaveBeenCalledWith(
                expect.any(Function),
                dockerManager.poolCheckInterval
            );
            
            global.setInterval = originalSetInterval;
        });

        test('should remove container from pool after interval with no requests', async () => {
            dockerManager.containerPool = [
                { name: 'old-container', port: 8001 }
            ];
            
            dockerManager.lastDockerRequestTime = Date.now() - 11000;

            const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
            
            const originalSetInterval = global.setInterval;
            global.setInterval = jest.fn((callback) => {
                setImmediate(callback);
                return 'mock-timer-id';
            });
            
            dockerManager.poolWatcher();
            
            await new Promise(resolve => setImmediate(resolve));
            await new Promise(resolve => setImmediate(resolve));

            expect(mockContainer.stop).toHaveBeenCalled();
            expect(dockerManager.containerPool).toHaveLength(0);
            expect(consoleSpy).toHaveBeenCalledWith('Stopped and removed container: old-container (port 8001)');
            
            consoleSpy.mockRestore();
            global.setInterval = originalSetInterval;
        });

        test('should not remove container if recent request exists', async () => {
            dockerManager.containerPool = [
                { name: 'recent-container', port: 8001 }
            ];
            
            dockerManager.lastDockerRequestTime = Date.now();

            const originalSetInterval = global.setInterval;
            global.setInterval = jest.fn((callback) => {
                setImmediate(callback);
                return 'mock-timer-id';
            });
            
            dockerManager.poolWatcher();
            
            await new Promise(resolve => setImmediate(resolve));

            expect(mockContainer.stop).not.toHaveBeenCalled();
            expect(dockerManager.containerPool).toHaveLength(1);
            
            global.setInterval = originalSetInterval;
        });
    });

    describe('shutdown', () => {
        test('should shutdown gracefully', async () => {
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
            dockerManager.watcherInterval = 'mock-interval';
            global.clearInterval = jest.fn();
            jest.spyOn(dockerManager, 'stopAllContainers').mockResolvedValue();
            
            await dockerManager.shutdown();
            
            expect(dockerManager.isShuttingDown).toBe(true);
            expect(global.clearInterval).toHaveBeenCalledWith('mock-interval');
            expect(dockerManager.stopAllContainers).toHaveBeenCalled();
            expect(process.removeAllListeners).toHaveBeenCalledWith('SIGINT');
            expect(process.removeAllListeners).toHaveBeenCalledWith('SIGTERM');
            expect(process.removeAllListeners).toHaveBeenCalledWith('beforeExit');
            expect(consoleSpy).toHaveBeenCalledWith('DockerManager shutting down...');
            expect(consoleSpy).toHaveBeenCalledWith('DockerManager shutdown complete');
            
            consoleSpy.mockRestore();
        });

        test('should not shutdown twice', async () => {
            dockerManager.isShuttingDown = true;
            jest.spyOn(dockerManager, 'stopAllContainers').mockResolvedValue();
            
            await dockerManager.shutdown();
            
            expect(dockerManager.stopAllContainers).not.toHaveBeenCalled();
        });
    });

    describe('healthCheck', () => {
        test('should remove dead containers', async () => {
            const deadContainer = { name: 'dead-container', port: 8001, id: 'dead-id' };
            const aliveContainer = { name: 'alive-container', port: 8002, id: 'alive-id' };
            
            dockerManager.containerPool = [aliveContainer, deadContainer];
            
            // Mock inspect for different containers
            mockDocker.getContainer.mockImplementation((name) => {
                if (name === 'dead-container') {
                    return {
                        inspect: jest.fn().mockResolvedValue({ State: { Running: false } })
                    };
                }
                return {
                    inspect: jest.fn().mockResolvedValue({ State: { Running: true } })
                };
            });
            
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
            
            const result = await dockerManager.healthCheck();
            
            expect(dockerManager.containerPool).toEqual([aliveContainer]);
            expect(result).toEqual({
                totalContainers: 1,
                deadContainersRemoved: 1,
                healthy: true
            });
            expect(consoleSpy).toHaveBeenCalledWith('Removed 1 dead containers from pool');
            
            consoleSpy.mockRestore();
        });

        test('should report healthy when containers exist', async () => {
            dockerManager.containerPool = [{ name: 'container-1', port: 8001, id: 'id-1' }];
            
            const result = await dockerManager.healthCheck();
            
            expect(result.healthy).toBe(true);
        });

        test('should report unhealthy when shutting down with no containers', async () => {
            dockerManager.isShuttingDown = true;
            dockerManager.containerPool = [];
            
            const result = await dockerManager.healthCheck();
            
            expect(result.healthy).toBe(false);
        });
    });

    describe('terminateContainer', () => {
        test('should terminate container with timeout', async () => {
            const containerInfo = { name: 'test-container', port: 3000 };
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
            
            await dockerManager.terminateContainer(containerInfo);
            
            expect(mockContainer.stop).toHaveBeenCalled();
            expect(mockContainer.remove).toHaveBeenCalled();
            expect(consoleSpy).toHaveBeenCalledWith('Stopped and removed container: test-container (port 3000)');
            
            consoleSpy.mockRestore();
        });

        test('should force remove container if termination times out', async () => {
            const containerInfo = { name: 'test-container', port: 3000 };
            mockContainer.stop.mockImplementation(() => new Promise(() => {})); // Never resolves
            
            const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
            const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
            
            jest.useFakeTimers();
            
            const terminatePromise = dockerManager.terminateContainer(containerInfo);
            
            jest.advanceTimersByTime(10100);
            
            await terminatePromise;
            
            expect(mockContainer.remove).toHaveBeenCalledWith({ force: true });
            expect(consoleLogSpy).toHaveBeenCalledWith('Force removed container: test-container');
            
            consoleErrorSpy.mockRestore();
            consoleLogSpy.mockRestore();
            jest.useRealTimers();
        });
    });

    describe('removeContainerFromPool', () => {
        test('should remove container by name', () => {
            dockerManager.containerPool = [
                { name: 'container-1', port: 8001, id: 'id-1' },
                { name: 'container-2', port: 8002, id: 'id-2' }
            ];
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
            
            const removed = dockerManager.removeContainerFromPool('container-1');
            
            expect(dockerManager.containerPool).toHaveLength(1);
            expect(dockerManager.containerPool[0].name).toBe('container-2');
            expect(removed.name).toBe('container-1');
            expect(consoleSpy).toHaveBeenCalledWith('Removed container container-1 from pool');
            
            consoleSpy.mockRestore();
        });

        test('should return null if container not found', () => {
            dockerManager.containerPool = [{ name: 'container-1', port: 8001, id: 'id-1' }];
            
            const removed = dockerManager.removeContainerFromPool('non-existent');
            
            expect(removed).toBeNull();
            expect(dockerManager.containerPool).toHaveLength(1);
        });
    });
});