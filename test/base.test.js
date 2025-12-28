const BaseServerlessManager = require('../lib/managers/base');

// Minimal subclass to implement abstract methods for testing
class FakeManager extends BaseServerlessManager {
    constructor(options = {}) {
        super(options);
        this.terminated = [];
    }

    getResourceType() {
        return 'test';
    }

    async isResourceAlive(resourceInfo) {
        // treat resources with name starting with 'alive' as alive
        return resourceInfo.name && resourceInfo.name.startsWith('alive');
    }

    async terminateResource(resourceInfo) {
        this.terminated.push(resourceInfo.name);
        return Promise.resolve();
    }

    async onShutdown() {
        this.shutdownHookCalled = true;
    }
}

describe('BaseServerlessManager', () => {
    let mgr;

    beforeEach(() => {
        jest.clearAllMocks();
        mgr = new FakeManager({ maxPoolSize: 3, poolCheckInterval: 1000, shutdownTimeout: 500 });
    });

    afterEach(() => {
        // ensure any timers are cleared
        mgr.stopPoolWatcher();
        mgr.isShuttingDown = false;
        jest.useRealTimers();
    });

    test('constructor sets defaults and properties', () => {
        expect(mgr.maxPoolSize).toBe(3);
        expect(mgr.poolCheckInterval).toBe(1000);
        expect(mgr.shutdownTimeout).toBe(500);
        expect(Array.isArray(mgr.pool)).toBe(true);
        expect(mgr.lastRequestTime).toBeGreaterThan(0);
        expect(mgr.watcherStarted).toBe(false);
        expect(mgr.watcherInterval).toBe(null);
        expect(mgr.isShuttingDown).toBe(false);
    });

    test('setupShutdownHandlers registers process.once handlers', () => {
        const spy = jest.spyOn(process, 'once');
        mgr.setupShutdownHandlers();
        expect(spy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
        expect(spy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
        expect(spy).toHaveBeenCalledWith('beforeExit', expect.any(Function));
        spy.mockRestore();
    });

    test('addToPool and canCreateNewResource work', () => {
        expect(mgr.getPoolSize()).toBe(0);
        expect(mgr.canCreateNewResource()).toBe(true);

        expect(mgr.addToPool({ name: 'one' })).toBe(true);
        expect(mgr.addToPool({ name: 'two' })).toBe(true);
        expect(mgr.addToPool({ name: 'three' })).toBe(true);
        expect(mgr.addToPool({ name: 'four' })).toBe(false); // exceeds max

        expect(mgr.getPoolSize()).toBe(3);
        expect(mgr.canCreateNewResource()).toBe(false);
    });

    test('removeFromPool removes and returns resource', () => {
        mgr.pool = [{ name: 'a' }, { name: 'b' }];
        const loggerSpy = jest.spyOn(require('../lib/utils/logger'), 'info');
        const removed = mgr.removeFromPool('a');
        expect(removed).toEqual({ name: 'a' });
        expect(mgr.pool).toHaveLength(1);
        expect(loggerSpy).toHaveBeenCalledWith('test a removed from pool');
        loggerSpy.mockRestore();
    });

    test('selectFromPool round-robin selection', () => {
        mgr.pool = [{ name: 'p1' }, { name: 'p2' }, { name: 'p3' }];
        const originalNow = Date.now;
        Date.now = () => 2000 * 1000; // divisible so index deterministic
        const selected = mgr.selectFromPool();
        expect(['p1', 'p2', 'p3']).toContain(selected.name);
        Date.now = originalNow;
    });

    test('clearPool empties pool and updates lastRequestTime', () => {
        mgr.pool = [{ name: 'x' }];
        const before = Date.now();
        mgr.clearPool();
        const after = Date.now();
        expect(mgr.pool).toEqual([]);
        expect(mgr.lastRequestTime).toBeGreaterThanOrEqual(before);
        expect(mgr.lastRequestTime).toBeLessThanOrEqual(after);
    });

    test('stopAllResources calls terminateResource and clears pool', async () => {
        mgr.pool = [{ name: 'alive-1' }, { name: 'dead-1' }];
        await mgr.stopAllResources();
        expect(mgr.terminated).toContain('alive-1');
        expect(mgr.terminated).toContain('dead-1');
        expect(mgr.pool).toHaveLength(0);
    });

    test('healthCheck removes dead resources and reports correctly', async () => {
        mgr.pool = [{ name: 'dead-1' }, { name: 'alive-2' }];
        const res = await mgr.healthCheck();
        // resource type is 'test' -> capitalized 'Test' -> keys totalTests and deadTestsRemoved
        expect(res).toHaveProperty('totalTests');
        expect(res).toHaveProperty('deadTestsRemoved');
        expect(res.totalTests).toBe(1);
        expect(res.deadTestsRemoved).toBe(1);
        expect(res.healthy).toBe(true);
    });

    test('shutdown stops watcher, stops resources, removes listeners and calls onShutdown', async () => {
        mgr.pool = [{ name: 'alive-1' }];
        jest.spyOn(process, 'removeAllListeners').mockImplementation(() => { });
        const stopSpy = jest.spyOn(mgr, 'stopAllResources');
        await mgr.shutdown();
        expect(mgr.isShuttingDown).toBe(true);
        expect(stopSpy).toHaveBeenCalled();
        expect(mgr.shutdownHookCalled).toBe(true);
        process.removeAllListeners.mockRestore();
    });


    test('metrics are collected correctly', () => {
        // Initial state
        expect(mgr.getMetrics()).toEqual({
            requests: 0,
            hits: 0,
            misses: 0,
            additions: 0,
            evictions: 0,
            removals: 0
        });

        // Add to pool -> additions++
        mgr.addToPool({ name: 'res1' });
        expect(mgr.getMetrics().additions).toBe(1);

        // Select from pool -> requests++, hits++
        mgr.selectFromPool();
        expect(mgr.getMetrics().requests).toBe(1);
        expect(mgr.getMetrics().hits).toBe(1);

        // Remove from pool -> removals++
        mgr.removeFromPool('res1');
        expect(mgr.getMetrics().removals).toBe(1);

        // Select from empty pool -> requests++, misses++
        mgr.selectFromPool();
        expect(mgr.getMetrics().requests).toBe(2);
        expect(mgr.getMetrics().misses).toBe(1);
    });

    test('metrics track evictions correctly', async () => {
        // Start watcher
        await mgr.startPoolWatcher();

        // Add resource
        mgr.addToPool({ name: 'res1' });

        // Mock time to force eviction
        // Default poolCheckInterval is 1000ms (set in beforeEach)
        // We need (now - lastRequestTime) > 1000

        // Simulate time passing and watcher interval triggering
        // Since we can't easily wait for setInterval in unit test without fake timers,
        // we'll manually invoke the logic or trust fake timers if set up.
        // But here we can use Jest's advanceTimersByTime if we use fake timers.

        jest.useFakeTimers();
        // Re-create manager to pick up fake timers for setInterval? 
        // Or just assume existing setInterval works with fake timers.
        // Actually BaseManager uses setInterval which Jest mocks.

        // We need to restart watcher to use mocked timer?
        mgr.stopPoolWatcher();
        mgr.watcherStarted = false;
        await mgr.startPoolWatcher();

        // Advance time to trigger eviction
        jest.advanceTimersByTime(2000);

        // In poolWatcher loop, it checks Date.now()
        // We need to mock Date.now() to return advanced time
        const spy = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000);

        // Trigger the interval callback manually or let jest run it
        jest.runOnlyPendingTimers();

        // Should have evicted
        expect(mgr.getMetrics().evictions).toBe(1);
        expect(mgr.pool).toHaveLength(0);

        spy.mockRestore();
    });

    test('getPrometheusMetrics returns correct format', () => {
        // Setup some metrics
        mgr.addToPool({ name: 'res1' });
        mgr.selectFromPool();
        mgr.removeFromPool('res1');
        mgr.selectFromPool(); // Miss

        const output = mgr.getPrometheusMetrics();

        // Check for essential parts of the output
        const expectedLabels = '{resource_type="test",manager="FakeManager"}';

        // Check Counter Headers and Values
        expect(output).toContain('# HELP serverless_manager_pool_requests_total Total number of pool acquisition requests');
        expect(output).toContain('# TYPE serverless_manager_pool_requests_total counter');
        expect(output).toContain(`serverless_manager_pool_requests_total${expectedLabels} 2`);

        expect(output).toContain('# HELP serverless_manager_pool_hits_total Total number of successful pool hits');
        expect(output).toContain(`serverless_manager_pool_hits_total${expectedLabels} 1`);

        expect(output).toContain('# HELP serverless_manager_pool_misses_total Total number of pool misses');
        expect(output).toContain(`serverless_manager_pool_misses_total${expectedLabels} 1`);

        expect(output).toContain('# HELP serverless_manager_pool_additions_total Total number of resources added to pool');
        expect(output).toContain(`serverless_manager_pool_additions_total${expectedLabels} 1`);

        expect(output).toContain('# HELP serverless_manager_pool_removals_total Total number of resources removed from pool');
        expect(output).toContain(`serverless_manager_pool_removals_total${expectedLabels} 1`);

        // Check Gauge
        expect(output).toContain('# HELP serverless_manager_pool_size Current number of resources in pool');
        expect(output).toContain('# TYPE serverless_manager_pool_size gauge');
        expect(output).toContain(`serverless_manager_pool_size${expectedLabels} 0`);
    });
});
