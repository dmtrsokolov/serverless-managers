
const BaseServerlessManager = require('../lib/managers/base');
const ProcessManager = require('../lib/managers/process');
const DockerManager = require('../lib/managers/docker');
const WorkerManager = require('../lib/managers/worker');
const pidusage = require('pidusage');

// Mock dependencies
jest.mock('pidusage');
jest.mock('../lib/utils/port', () => ({
    getAvailablePort: jest.fn().mockResolvedValue(8080)
}));
jest.mock('dockerode');
jest.mock('child_process');

describe('Resource Monitoring', () => {
    describe('BaseServerlessManager', () => {
        let manager;

        class TestManager extends BaseServerlessManager {
            getResourceType() { return 'test'; }
            async isResourceAlive() { return true; }
            async terminateResource() { }
            async getResourceUsage(info) {
                return { cpu: 50, memory: 1024 };
            }
        }

        beforeEach(() => {
            manager = new TestManager();
        });

        afterEach(async () => {
            await manager.shutdown();
        });

        test('should start and stop monitoring loop', async () => {
            jest.useFakeTimers();
            manager.startResourceMonitoring(1000);

            expect(manager.resourceMonitorInterval).not.toBeNull();

            // Add a dummy resource
            manager.pool.push({ name: 'test-1' });

            // Fast forward time
            jest.advanceTimersByTime(1100);

            // Wait for async loop (might need a tick)
            await Promise.resolve();
            await Promise.resolve();

            // Check if metrics were populated
            const info = manager.getPoolInfo();
            expect(info.resources[0].usage).toBeDefined();
            expect(info.resources[0].usage.cpu).toBe(50);

            manager.stopResourceMonitoring();
            expect(manager.resourceMonitorInterval).toBeNull();
            jest.useRealTimers();
        });
    });

    describe('ProcessManager', () => {
        let manager;

        beforeEach(() => {
            manager = new ProcessManager();
            pidusage.mockReset();
        });

        afterEach(async () => {
            await manager.shutdown();
        });

        test('should get resource usage via pidusage', async () => {
            const mockProcess = { pid: 12345, killed: false };
            const resourceInfo = { name: 'proc-1', process: mockProcess };

            pidusage.mockResolvedValue({ cpu: 10.5, memory: 2048 });

            const usage = await manager.getResourceUsage(resourceInfo);

            expect(pidusage).toHaveBeenCalledWith(12345);
            expect(usage).toEqual({ cpu: 10.5, memory: 2048 });
        });

        test('should return null if process is killed', async () => {
            const mockProcess = { pid: 12345, killed: true };
            const usage = await manager.getResourceUsage({ process: mockProcess });
            expect(usage).toBeNull();
        });
    });

    describe('DockerManager', () => {
        let manager;
        let mockContainer;

        beforeEach(() => {
            manager = new DockerManager();
            mockContainer = {
                stats: jest.fn()
            };
            manager.docker.getContainer = jest.fn().mockReturnValue(mockContainer);
        });

        afterEach(async () => {
            await manager.shutdown();
        });

        test('should calculate CPU and memory from docker stats', async () => {
            const mockStats = {
                cpu_stats: {
                    cpu_usage: { total_usage: 2000000000 },
                    system_cpu_usage: 10000000000,
                    online_cpus: 2
                },
                precpu_stats: {
                    cpu_usage: { total_usage: 1000000000 },
                    system_cpu_usage: 5000000000
                },
                memory_stats: {
                    usage: 5000000
                }
            };

            mockContainer.stats.mockResolvedValue(mockStats);

            const usage = await manager.getResourceUsage({ name: 'c-1' });

            // CPU Delta = 1000000000
            // System Delta = 5000000000
            // Ratio = 0.2
            // * 2 CPUs = 0.4
            // * 100 = 40%

            expect(usage).toEqual({
                cpu: 40,
                memory: 5000000
            });
        });
    });

    describe('WorkerManager', () => {
        let manager;

        beforeEach(() => {
            manager = new WorkerManager();
        });

        afterEach(async () => {
            await manager.shutdown();
        });

        test('should get CPU usage from eventLoopUtilization', async () => {
            const mockELU = { idle: 0, active: 10, utilization: 0.1 };
            const mockWorker = {
                performance: {
                    eventLoopUtilization: jest.fn()
                }
            };

            // First call returns initial state (mocked behavior)
            mockWorker.performance.eventLoopUtilization
                .mockReturnValueOnce(mockELU) // For 'lastElu || ...'
                .mockReturnValueOnce({ utilization: 0.15 }) // For 'currentElu' calculation
                .mockReturnValueOnce('new-state'); // For updating lastElu

            const resourceInfo = { worker: mockWorker };
            const usage = await manager.getResourceUsage(resourceInfo);

            expect(usage.cpu).toBe(15); // 0.15 * 100
            expect(usage.memory).toBe(0);
        });
    });
});
