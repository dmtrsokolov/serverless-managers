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
        jest.spyOn(process, 'removeAllListeners').mockImplementation(() => {});
        const stopSpy = jest.spyOn(mgr, 'stopAllResources');
        await mgr.shutdown();
        expect(mgr.isShuttingDown).toBe(true);
        expect(stopSpy).toHaveBeenCalled();
        expect(mgr.shutdownHookCalled).toBe(true);
        process.removeAllListeners.mockRestore();
    });
});
