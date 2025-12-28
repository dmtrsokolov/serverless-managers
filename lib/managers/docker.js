const Docker = require('dockerode');
const { getAvailablePort } = require('../utils/port');
const BaseServerlessManager = require('./base');
const logger = require('../utils/logger');

class DockerManager extends BaseServerlessManager {
    constructor(options = {}) {
        super(options);

        this.docker = new Docker();
        this.defaultContainerName = options.defaultContainerName || 'my-nodejs-express';
        this.defaultImageName = options.defaultImageName || 'my-nodejs-express';
        this.containerTimeout = options.containerTimeout || 30000; // 30 seconds
        this.shutdownTimeout = options.shutdownTimeout || 10000; // 10 seconds for Docker operations
    }

    // Backward compatibility: expose pool as containerPool
    get containerPool() {
        return this.pool;
    }

    set containerPool(value) {
        this.pool = value;
    }

    // Backward compatibility: expose lastRequestTime as lastDockerRequestTime
    get lastDockerRequestTime() {
        return this.lastRequestTime;
    }

    set lastDockerRequestTime(value) {
        this.lastRequestTime = value;
    }

    // Backward compatibility: expose terminateResource as terminateContainer
    async terminateContainer(containerInfo) {
        return this.terminateResource(containerInfo);
    }

    getResourceType() {
        return 'container';
    }

    async terminateResource(containerInfo) {
        const { name: containerName, port: containerPort } = containerInfo;
        try {
            await new Promise((resolve, reject) => {
                const timeoutId = setTimeout(() => {
                    reject(new Error('Container termination timeout'));
                }, this.shutdownTimeout);

                this.stopContainer(containerName).then(() => {
                    clearTimeout(timeoutId);
                    resolve();
                }).catch(err => {
                    clearTimeout(timeoutId);
                    reject(err);
                });
            });
            logger.info(`Stopped and removed container: ${containerName} (port ${containerPort})`);
        } catch (err) {
            logger.error(`Error stopping container ${containerName}:`, err.message);
            // Force remove if graceful stop fails
            try {
                const container = this.docker.getContainer(containerName);
                await container.remove({ force: true });
                logger.info(`Force removed container: ${containerName}`);
            } catch (forceErr) {
                logger.error(`Error force removing container ${containerName}:`, forceErr.message);
            }
        }
    }

    async isResourceAlive(containerInfo) {
        try {
            const container = this.docker.getContainer(containerInfo.name);
            const info = await container.inspect();
            return info.State.Running;
        } catch (err) {
            // Container doesn't exist
            return false;
        }
    }

    formatResourceInfo(resourceInfo) {
        const info = super.formatResourceInfo(resourceInfo);
        info.id = resourceInfo.id;
        return info;
    }

    async getResourceUsage(resourceInfo) {
        try {
            const container = this.docker.getContainer(resourceInfo.name);
            const stats = await container.stats({ stream: false });

            // Calculate CPU percentage
            // Valid only for Linux containers, might be different on Windows/Mac
            // Formula from Docker docs
            const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
            const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
            const numberCpus = stats.cpu_stats.online_cpus;

            let cpuPercent = 0.0;
            if (systemDelta > 0 && cpuDelta > 0) {
                cpuPercent = (cpuDelta / systemDelta) * numberCpus * 100.0;
            }

            return {
                cpu: cpuPercent,
                memory: stats.memory_stats.usage // Bytes
            };
        } catch (err) {
            return null;
        }
    }

    async getOrCreateContainerInPool() {
        if (this.isShuttingDown) {
            throw new Error('DockerManager is shutting down');
        }

        const scriptDirPath = this.scriptDirPath;
        const scriptFiles = this.scriptFiles;

        if (!scriptDirPath) {
            throw new Error('Script directory path is not configured. Provide scriptDirPath and scriptFiles in constructor.');
        }

        this.updateLastRequestTime();
        await this.startPoolWatcher();
        this.startResourceMonitoring();

        // Try to create a new container if pool is not full
        if (this.canCreateNewResource()) {
            try {
                const port = await getAvailablePort();
                const containerName = `${this.defaultContainerName}-${port}-${Date.now()}`;
                const result = await this.createContainer(port, containerName, scriptDirPath, scriptFiles);

                // Double-check pool size in case it changed during async operation
                if (this.canCreateNewResource()) {
                    const containerInfo = {
                        name: containerName,
                        port,
                        id: result.id,
                        createdAt: Date.now(),
                        lastUsed: Date.now()
                    };
                    this.addToPool(containerInfo);
                    logger.info(`Started container: ${containerName} (port ${port})`);
                    return containerInfo;
                } else {
                    // Pool filled up while we were creating, terminate this container
                    await this.terminateResource({ name: containerName, port });
                }
            } catch (err) {
                logger.warn(`Failed to create new container: ${err.message}`);
                // Continue to try existing containers
            }
        }

        // Return existing container from pool
        const selectedContainer = this.selectFromPool();

        if (selectedContainer) {
            // Verify container is still alive
            const isAlive = await this.isResourceAlive(selectedContainer);
            if (isAlive) {
                selectedContainer.lastUsed = Date.now();
                return selectedContainer;
            } else {
                // Remove dead container and try again
                this.removeFromPool(selectedContainer.name);
                if (this.pool.length > 0) {
                    return this.pool[0];
                }
            }
        }

        throw new Error('No containers available in pool');
    }

    async createContainer(port = 8080, containerName = null, scriptDir, scriptFiles = ['index.js']) {
        return new Promise(async (resolve, reject) => {
            let isResolved = false;

            // Set timeout for container creation
            const timeoutId = setTimeout(() => {
                if (!isResolved) {
                    isResolved = true;
                    reject(new Error(`Container creation timeout after ${this.containerTimeout}ms`));
                }
            }, this.containerTimeout);

            try {
                containerName = containerName || this.defaultContainerName;
                logger.info(`Creating container "${containerName}" on port ${port}`);

                if (!scriptDir) {
                    clearTimeout(timeoutId);
                    return reject(new Error('scriptDir is required to bind the script into the container'));
                }

                scriptFiles = Array.isArray(scriptFiles) ? scriptFiles : [scriptFiles];

                if (!scriptFiles || scriptFiles.length === 0) {
                    clearTimeout(timeoutId);
                    return reject(new Error('At least one script file must be specified'));
                }

                const binds = scriptFiles.map(file => `${scriptDir}/${file}:/usr/src/app/${file}`);

                // Create and start the container
                const container = await this.docker.createContainer({
                    Image: this.defaultImageName,
                    name: containerName,
                    ExposedPorts: { '9000/tcp': {} },
                    HostConfig: {
                        PortBindings: { '9000/tcp': [{ HostPort: String(port) }] },
                        Binds: binds
                    },
                    WorkingDir: '/usr/src/app',
                    Cmd: ['node', 'index.js', '9000']
                });

                await container.start();

                if (!isResolved) {
                    isResolved = true;
                    clearTimeout(timeoutId);
                    resolve({ id: container.id, status: 'started', name: containerName });
                }
            } catch (err) {
                clearTimeout(timeoutId);
                if (!isResolved) {
                    isResolved = true;
                    reject(err);
                }
            }
        });
    }

    removeContainerFromPool(containerName) {
        return this.removeFromPool(containerName);
    }

    async stopContainer(containerName = null) {
        containerName = containerName || this.defaultContainerName;

        try {
            const container = this.docker.getContainer(containerName);
            try {
                await container.stop();
            } catch (err) {
                // Ignore error if container is already stopped (HTTP code 304)
                if (err.statusCode !== 304) throw err;
            }
            await container.remove();
            return { status: 'stopped and removed', name: containerName };
        } catch (err) {
            if (err.statusCode === 404) {
                return { status: 'container not found', name: containerName };
            }
            throw err;
        }
    }

    getPoolInfo() {
        const info = super.getPoolInfo();
        // Return with 'containers' instead of 'resources' for backward compatibility
        const { resources, ...rest } = info;
        return {
            ...rest,
            containers: resources
        };
    }

    // shutdown() is handled by BaseServerlessManager

    async stopAllContainers() {
        return this.stopAllResources();
    }

    async createResource(config = {}) {
        const scriptDirPath = config.scriptDirPath || this.scriptDirPath;
        const scriptFiles = config.scriptFiles || this.scriptFiles;

        if (!scriptDirPath) {
            throw new Error('Script directory path is required for pre-warming');
        }

        try {
            const port = await getAvailablePort();
            const containerName = `${this.defaultContainerName}-${port}-${Date.now()}`;
            const result = await this.createContainer(port, containerName, scriptDirPath, scriptFiles);

            return {
                name: containerName,
                port,
                id: result.id,
                createdAt: Date.now(),
                lastUsed: Date.now()
            };
        } catch (err) {
            logger.error(`Failed to create resource: ${err.message}`);
            throw err;
        }
    }
}

module.exports = DockerManager;