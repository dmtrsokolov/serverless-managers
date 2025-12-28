const { Worker } = require('worker_threads');
const { getAvailablePort } = require('../utils/port');
const BaseServerlessManager = require('./base');
const logger = require('../utils/logger');

class WorkerManager extends BaseServerlessManager {
    constructor(options = {}) {
        super(options);

        this.workerTimeout = options.workerTimeout || 30000; // 30 seconds
        this.shutdownTimeout = options.shutdownTimeout || 5000; // 5 seconds
    }

    // Backward compatibility: expose pool as workerPool
    get workerPool() {
        return this.pool;
    }

    set workerPool(value) {
        this.pool = value;
    }

    // Backward compatibility: expose lastRequestTime as lastWorkerRequestTime
    get lastWorkerRequestTime() {
        return this.lastRequestTime;
    }

    set lastWorkerRequestTime(value) {
        this.lastRequestTime = value;
    }

    // Backward compatibility: expose terminateResource as terminateWorker
    async terminateWorker(workerInfo) {
        return this.terminateResource(workerInfo);
    }

    getResourceType() {
        return 'worker';
    }

    async terminateResource(workerInfo) {
        const { name: workerName, worker } = workerInfo;
        try {
            await new Promise((resolve, reject) => {
                const timeoutId = setTimeout(() => {
                    reject(new Error('Worker termination timeout'));
                }, this.shutdownTimeout);

                worker.terminate().then(() => {
                    clearTimeout(timeoutId);
                    resolve();
                }).catch(err => {
                    clearTimeout(timeoutId);
                    reject(err);
                });
            });
            console.log(`Stopped and removed worker: ${workerName}`);
        } catch (err) {
            logger.error(`Error stopping worker ${workerName}:`, err.message);
            // Force kill if graceful termination fails
            try {
                worker.kill?.();
            } catch (killErr) {
                logger.error(`Error force killing worker ${workerName}:`, killErr.message);
            }
        }
    }

    async isResourceAlive(workerInfo) {
        return workerInfo.worker && workerInfo.worker.threadId !== null;
    }

    formatResourceInfo(resourceInfo) {
        const info = super.formatResourceInfo(resourceInfo);
        info.alive = resourceInfo.worker && resourceInfo.worker.threadId !== null;
        return info;
    }

    async getResourceUsage(resourceInfo) {
        if (!resourceInfo.worker) return null;

        const worker = resourceInfo.worker;

        // Use previous ELU if available to calculate delta
        const lastElu = resourceInfo.lastElu || worker.performance.eventLoopUtilization();
        const currentElu = worker.performance.eventLoopUtilization(lastElu);

        // Update stored last ELU
        resourceInfo.lastElu = worker.performance.eventLoopUtilization();

        return {
            cpu: currentElu.utilization * 100, // Percentage
            memory: 0 // Cannot easily get per-worker memory
        };
    }

    async getOrCreateWorkerInPool(scriptPath) {
        if (this.isShuttingDown) {
            throw new Error('WorkerManager is shutting down');
        }

        if (!scriptPath) {
            throw new Error('Script path is required');
        }

        // Check if the script path exists
        const fs = require('fs');
        if (!fs.existsSync(scriptPath)) {
            throw new Error(`Script path does not exist: ${scriptPath}`);
        }

        this.updateLastRequestTime();
        await this.startPoolWatcher();
        this.startResourceMonitoring();

        // Try to create a new worker if pool is not full
        if (this.canCreateNewResource()) {
            try {
                const port = await getAvailablePort();
                const workerName = `worker-${port}-${Date.now()}`;
                const workerInfo = await this.createWorker(scriptPath, port, workerName);

                // Double-check pool size in case it changed during async operation
                if (this.canCreateNewResource()) {
                    this.addToPool(workerInfo);
                    console.log(`Started worker: ${workerName} (port ${port})`);
                    return workerInfo;
                } else {
                    // Pool filled up while we were creating, terminate this worker
                    await this.terminateResource(workerInfo);
                }
            } catch (err) {
                console.warn(`Failed to create new worker: ${err.message}`);
                // Continue to try existing workers
            }
        }

        // Return existing worker from pool
        const selectedWorker = this.selectFromPool();

        if (selectedWorker) {
            // Verify worker is still alive
            if (await this.isResourceAlive(selectedWorker)) {
                selectedWorker.lastUsed = Date.now();
                return selectedWorker;
            } else {
                // Remove dead worker and try again
                this.removeFromPool(selectedWorker.name);
                if (this.pool.length > 0) {
                    return this.pool[0];
                }
            }
        }

        throw new Error('No workers available in pool');
    }

    createWorker(scriptPath, port, workerName) {
        return new Promise((resolve, reject) => {
            let isResolved = false;

            // Set timeout for worker creation
            const timeoutId = setTimeout(() => {
                if (!isResolved) {
                    isResolved = true;
                    reject(new Error(`Worker creation timeout after ${this.workerTimeout}ms`));
                }
            }, this.workerTimeout);

            try {
                const worker = new Worker(scriptPath, {
                    workerData: { port, name: workerName },
                    // Add resource limits for better stability
                    resourceLimits: {
                        maxOldGenerationSizeMb: 100,
                        maxYoungGenerationSizeMb: 50
                    }
                });

                const cleanup = () => {
                    clearTimeout(timeoutId);
                };

                worker.on('online', () => {
                    if (!isResolved) {
                        isResolved = true;
                        cleanup();
                        const workerInfo = {
                            name: workerName,
                            port,
                            worker,
                            createdAt: Date.now(),
                            lastUsed: Date.now()
                        };
                        resolve(workerInfo);
                    }
                });

                worker.on('message', (msg) => {
                    logger.info(`worker ${workerName} message:`, msg);
                });

                worker.on('error', (err) => {
                    logger.error(`worker ${workerName} error:`, err);
                    if (!isResolved) {
                        isResolved = true;
                        cleanup();
                        reject(err);
                    } else {
                        // Worker error after creation, remove from pool
                        this.removeWorkerFromPool(workerName);
                    }
                });

                worker.on('exit', (code) => {
                    logger.info(`worker ${workerName} exited with code ${code}`);
                    cleanup();
                    this.removeWorkerFromPool(workerName);
                });

            } catch (err) {
                clearTimeout(timeoutId);
                if (!isResolved) {
                    isResolved = true;
                    reject(err);
                }
            }
        });
    }

    removeWorkerFromPool(workerName) {
        return this.removeFromPool(workerName);
    }

    getPoolInfo() {
        const info = super.getPoolInfo();
        // Return with 'workers' instead of 'resources' for backward compatibility
        const { resources, ...rest } = info;
        return {
            ...rest,
            workers: resources
        };
    }

    // shutdown() is handled by BaseServerlessManager

    async stopAllWorkers() {
        return this.stopAllResources();
    }

    async createResource(config) {
        const { scriptPath } = config;
        if (!scriptPath) {
            throw new Error('Script path is required for pre-warming');
        }

        try {
            const port = await getAvailablePort();
            const workerName = `worker-${port}-${Date.now()}`;
            return await this.createWorker(scriptPath, port, workerName);
        } catch (err) {
            logger.error(`Failed to create resource: ${err.message}`);
            throw err;
        }
    }
}

module.exports = WorkerManager;