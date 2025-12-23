const { spawn } = require('child_process');
const { getAvailablePort } = require('../utils/port');
const BaseServerlessManager = require('./base');
const logger = require('../utils/logger');

class ProcessManager extends BaseServerlessManager {
    constructor(options = {}) {
        super(options);
        
        this.processTimeout = options.processTimeout || 30000; // 30 seconds
        this.shutdownTimeout = options.shutdownTimeout || 5000; // 5 seconds
    }

    // Backward compatibility: expose pool as processPool
    get processPool() {
        return this.pool;
    }

    set processPool(value) {
        this.pool = value;
    }

    // Backward compatibility: expose lastRequestTime as lastProcessRequestTime
    get lastProcessRequestTime() {
        return this.lastRequestTime;
    }

    set lastProcessRequestTime(value) {
        this.lastRequestTime = value;
    }

    // Backward compatibility: expose terminateResource as terminateProcess
    async terminateProcess(processInfo) {
        return this.terminateResource(processInfo);
    }

    getResourceType() {
        return 'process';
    }

    async terminateResource(processInfo) {
        const { name: processName, process: childProcess } = processInfo;
        try {
            await Promise.race([
                new Promise((resolve) => {
                    childProcess.once('exit', resolve);
                    childProcess.kill();
                }),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Process termination timeout')), this.shutdownTimeout)
                )
            ]);
            logger.info(`Stopped and removed process: ${processName}`);
        } catch (err) {
            logger.error(`Error stopping process ${processName}:`, err.message);
            // Force kill if graceful termination fails
            try {
                childProcess.kill('SIGKILL');
            } catch (killErr) {
                logger.error(`Error force killing process ${processName}:`, killErr.message);
            }
        }
    }

    async isResourceAlive(processInfo) {
        return processInfo.process && !processInfo.process.killed;
    }

    formatResourceInfo(resourceInfo) {
        return {
            name: resourceInfo.name,
            port: resourceInfo.port,
            createdAt: resourceInfo.createdAt,
            lastUsed: resourceInfo.lastUsed,
            alive: resourceInfo.process && !resourceInfo.process.killed
        };
    }

    async getOrCreateProcessInPool(scriptPath) {
        if (this.isShuttingDown) {
            throw new Error('ProcessManager is shutting down');
        }

        if (!scriptPath) {
            throw new Error('Script path is required');
        }

        this.updateLastRequestTime();
        await this.startPoolWatcher();

        // Try to create a new process if pool is not full
        if (this.canCreateNewResource()) {
            try {
                const port = await getAvailablePort();
                const processName = `process-${port}-${Date.now()}`;
                const processInfo = await this.createProcess(scriptPath, port, processName);
                
                // Double-check pool size in case it changed during async operation
                if (this.canCreateNewResource()) {
                    this.addToPool(processInfo);
                    logger.info(`Started process: ${processName} (port ${port})`);
                    return processInfo;
                } else {
                    // Pool filled up while we were creating, terminate this process
                    await this.terminateResource(processInfo);
                }
            } catch (err) {
                logger.warn(`Failed to create new process: ${err.message}`);
                // Continue to try existing processes
            }
        }
        
        // Return existing process from pool
        const selectedProcess = this.selectFromPool();
        
        if (selectedProcess) {
            // Verify process is still alive
            if (await this.isResourceAlive(selectedProcess)) {
                selectedProcess.lastUsed = Date.now();
                return selectedProcess;
            } else {
                // Remove dead process and try again
                this.removeFromPool(selectedProcess.name);
                if (this.pool.length > 0) {
                    return this.pool[0];
                }
            }
        }

        throw new Error('No processes available in pool');
    }

    createProcess(scriptPath, port, processName) {
        return new Promise((resolve, reject) => {
            let isResolved = false;
            
            // Set timeout for process creation
            const timeoutId = setTimeout(() => {
                if (!isResolved) {
                    isResolved = true;
                    reject(new Error(`Process creation timeout after ${this.processTimeout}ms`));
                }
            }, this.processTimeout);

            try {
                const childProcess = spawn('node', [scriptPath, port]);
                
                const cleanup = () => {
                    clearTimeout(timeoutId);
                };

                childProcess.stdout.once('data', (data) => {
                    logger.info(`${processName} stdout: ${data}`);
                    if (!isResolved) {
                        isResolved = true;
                        cleanup();
                        // Resolve when first stdout is received (indicates app started)
                        const processInfo = { 
                            name: processName, 
                            port, 
                            process: childProcess,
                            createdAt: Date.now(),
                            lastUsed: Date.now()
                        };
                        resolve(processInfo);
                    }
                });

                childProcess.stderr.on('data', (data) => {
                    logger.error(`${processName} stderr: ${data}`);
                });

                childProcess.on('close', (code) => {
                    logger.info(`${processName} exited with code ${code}`);
                    cleanup();
                    this.removeProcessFromPool(processName);
                });

                childProcess.on('error', (err) => {
                    logger.error(`${processName} error:`, err);
                    if (!isResolved) {
                        isResolved = true;
                        cleanup();
                        reject(err);
                    } else {
                        // Process error after creation, remove from pool
                        this.removeProcessFromPool(processName);
                    }
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

    removeProcessFromPool(processName) {
        return this.removeFromPool(processName);
    }

    getPoolInfo() {
        const info = super.getPoolInfo();
        // Return with 'processes' instead of 'resources' for backward compatibility
        const { resources, ...rest } = info;
        return {
            ...rest,
            processes: resources
        };
    }

    async shutdown() {
        if (this.isShuttingDown) {
            return;
        }

        logger.info('ProcessManager shutting down...');
        this.isShuttingDown = true;

        // Stop the pool watcher
        this.stopPoolWatcher();

        // Stop all processes
        await this.stopAllProcesses();

        // Remove process event listeners
        process.removeAllListeners('SIGINT');
        process.removeAllListeners('SIGTERM');
        process.removeAllListeners('beforeExit');

        logger.info('ProcessManager shutdown complete');
    }

    async healthCheck() {
        const deadProcesses = [];
        
        for (let i = this.pool.length - 1; i >= 0; i--) {
            const processInfo = this.pool[i];
            const isAlive = await this.isResourceAlive(processInfo);
            
            if (!isAlive) {
                deadProcesses.push(this.pool.splice(i, 1)[0]);
            }
        }

        if (deadProcesses.length > 0) {
            logger.info(`Removed ${deadProcesses.length} dead processes from pool`);
        }

        return {
            totalProcesses: this.pool.length,
            deadProcessesRemoved: deadProcesses.length,
            healthy: this.pool.length > 0 || !this.isShuttingDown
        };
    }

    async stopAllProcesses() {
        if (this.pool.length === 0) {
            return;
        }

        logger.info(`Stopping ${this.pool.length} processes...`);
        
        const terminatePromises = this.pool.map(processInfo => 
            this.terminateResource(processInfo).catch(err => {
                logger.error(`Error stopping process ${processInfo.name}:`, err.message);
            })
        );
        
        try {
            await Promise.allSettled(terminatePromises);
        } catch (err) {
            logger.error('Error during process termination:', err);
        }
        
        this.clearPool();
        logger.info('All processes stopped');
    }
}

module.exports = ProcessManager;