const Docker = require('dockerode');
const { getAvailablePort } = require('../utils/port');
const BaseServerlessManager = require('./base');

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
            await Promise.race([
                this.stopContainer(containerName),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Container termination timeout')), this.shutdownTimeout)
                )
            ]);
            console.log(`Stopped and removed container: ${containerName} (port ${containerPort})`);
        } catch (err) {
            console.error(`Error stopping container ${containerName}:`, err.message);
            // Force remove if graceful stop fails
            try {
                const container = this.docker.getContainer(containerName);
                await container.remove({ force: true });
                console.log(`Force removed container: ${containerName}`);
            } catch (forceErr) {
                console.error(`Error force removing container ${containerName}:`, forceErr.message);
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
        return {
            name: resourceInfo.name,
            port: resourceInfo.port,
            id: resourceInfo.id,
            createdAt: resourceInfo.createdAt,
            lastUsed: resourceInfo.lastUsed
        };
    }

    async getOrCreateContainerInPool(scriptDirPath, scriptFiles = ['index.js']) {
        if (this.isShuttingDown) {
            throw new Error('DockerManager is shutting down');
        }

        if (!scriptDirPath) {
            throw new Error('Script directory path is required');
        }

        this.updateLastRequestTime();
        await this.startPoolWatcher();

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
                    console.log(`Started container: ${containerName} (port ${port})`);
                    return containerInfo;
                } else {
                    // Pool filled up while we were creating, terminate this container
                    await this.terminateResource({ name: containerName, port });
                }
            } catch (err) {
                console.warn(`Failed to create new container: ${err.message}`);
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
                console.log(`Creating container "${containerName}" on port ${port}`);
                
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

    async shutdown() {
        if (this.isShuttingDown) {
            return;
        }

        console.log('DockerManager shutting down...');
        this.isShuttingDown = true;

        // Stop the pool watcher
        this.stopPoolWatcher();

        // Stop all containers
        await this.stopAllContainers();

        // Remove process event listeners
        process.removeAllListeners('SIGINT');
        process.removeAllListeners('SIGTERM');
        process.removeAllListeners('beforeExit');

        console.log('DockerManager shutdown complete');
    }

    async stopAllContainers() {
        if (this.pool.length === 0) {
            return;
        }

        console.log(`Stopping ${this.pool.length} containers...`);
        
        const terminatePromises = this.pool.map(containerInfo => 
            this.terminateResource(containerInfo).catch(err => {
                console.error(`Error stopping container ${containerInfo.name}:`, err.message);
            })
        );
        
        try {
            await Promise.allSettled(terminatePromises);
        } catch (err) {
            console.error('Error during container termination:', err);
        }
        
        this.clearPool();
        console.log('All containers stopped');
    }
}

module.exports = DockerManager;