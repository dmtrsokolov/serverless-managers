const BaseServerlessManager = require('../lib/managers/base');
const ProcessManager = require('../lib/managers/process');
const WorkerManager = require('../lib/managers/worker');
const path = require('path');
const fs = require('fs');

// Mock subclass for testing BaseServerlessManager logic
class MockManager extends BaseServerlessManager {
    constructor(options = {}) {
        super(options);
        this.createdResources = [];
    }

    getResourceType() {
        return 'mock';
    }

    async createResource(config) {
        const resource = {
            name: `mock-${Date.now()}-${Math.random()}`,
            config
        };
        this.createdResources.push(resource);
        return resource;
    }

    async terminateResource(resource) {
        // no-op
    }

    async isResourceAlive(resource) {
        return true;
    }
}

describe('Resource Pre-warming', () => {
    let manager;

    afterEach(async () => {
        if (manager) {
            await manager.shutdown();
        }
        jest.restoreAllMocks();
    });

    test('BaseServerlessManager should pre-warm resources to minPoolSize', async () => {
        manager = new MockManager({
            minPoolSize: 3,
            maxPoolSize: 5,
            preWarmConfig: { foo: 'bar' }
        });

        // Initial state
        expect(manager.pool.length).toBe(0);

        // Start watcher which triggers pre-warming
        await manager.startPoolWatcher();

        // Wait for async pre-warming
        await new Promise(resolve => setTimeout(resolve, 100));

        expect(manager.pool.length).toBe(3);
        expect(manager.createdResources.length).toBe(3);
        expect(manager.pool[0].config).toEqual({ foo: 'bar' });
    });

    test('BaseServerlessManager should not pre-warm if pool is already full enough', async () => {
        manager = new MockManager({
            minPoolSize: 2,
            maxPoolSize: 5
        });

        // Manually add resources
        manager.addToPool({ name: 'existing-1' });
        manager.addToPool({ name: 'existing-2' });

        await manager.startPoolWatcher();
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(manager.pool.length).toBe(2);
        // Should not have created new resources
        expect(manager.createdResources.length).toBe(0);
    });

    test('BaseServerlessManager should replenish pool when resources drop below minPoolSize', async () => {
        manager = new MockManager({
            minPoolSize: 3,
            maxPoolSize: 5,
            poolCheckInterval: 100
        });

        await manager.startPoolWatcher();
        await new Promise(resolve => setTimeout(resolve, 200));

        expect(manager.pool.length).toBe(3);

        // Remove a resource
        manager.pool.pop();
        expect(manager.pool.length).toBe(2);

        // Wait for watcher to run
        await new Promise(resolve => setTimeout(resolve, 200));

        // Should be back to 3
        expect(manager.pool.length).toBe(3);
    });

    test('ProcessManager createResource should return process info', async () => {
        const scriptPath = path.join(__dirname, 'fixtures', 'test-script.js');
        // efficient mocking of createProcess to avoid spawning real processes
        const createProcessSpy = jest.spyOn(ProcessManager.prototype, 'createProcess')
            .mockResolvedValue({ name: 'test-proc', pid: 123 });

        // Mock getAvailablePort
        jest.mock('../lib/utils/port', () => ({
            getAvailablePort: jest.fn().mockResolvedValue(1234)
        }));

        manager = new ProcessManager();
        const info = await manager.createResource({ scriptPath });

        expect(info).toEqual({ name: 'test-proc', pid: 123 });
        expect(createProcessSpy).toHaveBeenCalledWith(scriptPath, expect.any(Number), expect.stringContaining('process-'));
    });
});
