const { spawn } = require('child_process');
const { getAvailablePort } = require('../utils/port');
const fs = require('fs');
const path = require('path');
const BaseServerlessManager = require('./base');
const logger = require('../utils/logger');

class K8sManager extends BaseServerlessManager {
    constructor(options = {}) {
        super(options);

        this.k8s = null;
        this.kc = null;
        this.k8sApi = null;
        this.initialized = false;

        this.namespace = options.namespace || 'default';
        this.defaultPodName = options.defaultPodName || 'my-nodejs-pod';
        this.defaultPodPort = options.defaultPodPort || 9000;
        this.podTimeout = options.podTimeout || 60000; // 60 seconds for pod to be ready
        this.shutdownTimeout = options.shutdownTimeout || 15000; // 15 seconds for pod deletion

        this.portForwardProcesses = new Map(); // Track port-forward processes
    }

    // Backward compatibility: expose pool as podPool
    get podPool() {
        return this.pool;
    }

    set podPool(value) {
        this.pool = value;
    }

    // Backward compatibility: expose lastRequestTime as lastPodRequestTime
    get lastPodRequestTime() {
        return this.lastRequestTime;
    }

    set lastPodRequestTime(value) {
        this.lastRequestTime = value;
    }

    // Backward compatibility: expose terminateResource as terminatePod
    async terminatePod(podInfo) {
        return this.terminateResource(podInfo);
    }

    // Override poolWatcher to call terminatePod instead of terminateResource for backward compatibility with spies
    async poolWatcher() {
        if (this.watcherInterval) {
            return; // Already started
        }

        this.watcherInterval = setInterval(async () => {
            if (this.isShuttingDown) {
                return;
            }

            const now = Date.now();
            // If no new request in the last interval and pool is not empty
            if (this.pool.length > 0 && now - this.lastRequestTime > this.poolCheckInterval) {
                const podToRemove = this.pool.shift();
                if (podToRemove) {
                    try {
                        await this.terminatePod(podToRemove);
                        logger.info(`Stopped and removed pod: ${podToRemove.name} (port ${podToRemove.port})`);
                    } catch (err) {
                        logger.error(`Error stopping pod ${podToRemove.name}:`, err.message);
                    }
                }
            }
        }, this.poolCheckInterval);

        // Use unref() to allow process to exit gracefully even if interval is active
        if (this.watcherInterval && typeof this.watcherInterval.unref === 'function') {
            this.watcherInterval.unref();
        }
    }

    getResourceType() {
        return 'pod';
    }

    async initialize() {
        if (this.initialized) return;

        try {
            this.k8s = await import('@kubernetes/client-node');
            this.kc = new this.k8s.KubeConfig();
            this.kc.loadFromDefault();
            this.k8sApi = this.kc.makeApiClient(this.k8s.CoreV1Api);
            this.initialized = true;
        } catch (err) {
            throw new Error(`Failed to initialize Kubernetes client: ${err.message}`);
        }
    }

    async terminateResource(podInfo) {
        const { name: podName } = podInfo;

        try {
            // Kill port-forward process if exists
            const portForwardProcess = this.portForwardProcesses.get(podName);
            if (portForwardProcess && !portForwardProcess.killed) {
                portForwardProcess.kill('SIGTERM');
                this.portForwardProcesses.delete(podName);
            }

            // Delete pod with timeout
            await new Promise((resolve, reject) => {
                const timeoutId = setTimeout(() => {
                    reject(new Error('Pod termination timeout'));
                }, this.shutdownTimeout);

                this.deletePod(podName).then(() => {
                    clearTimeout(timeoutId);
                    resolve();
                }).catch(err => {
                    clearTimeout(timeoutId);
                    reject(err);
                });
            });
            logger.info(`Stopped and removed pod: ${podName}`);
        } catch (err) {
            logger.warn(`Failed to gracefully terminate pod ${podName}, attempting force delete:`, err.message);

            // Force delete pod
            try {
                await this.k8sApi.deleteNamespacedPod({
                    namespace: this.namespace,
                    name: podName,
                    body: {
                        gracePeriodSeconds: 0
                    }
                });
            } catch (forceErr) {
                logger.error(`Force delete also failed for pod ${podName}:`, forceErr.message);
                throw forceErr;
            }
        }
    }

    async isResourceAlive(podInfo) {
        try {
            const podStatus = await this.k8sApi.readNamespacedPod({
                namespace: this.namespace,
                name: podInfo.name
            });

            return podStatus.status && podStatus.status.phase === 'Running';
        } catch (err) {
            // Pod doesn't exist or can't be read
            return false;
        }
    }

    formatResourceInfo(resourceInfo) {
        return {
            name: resourceInfo.name,
            port: resourceInfo.port,
            createdAt: resourceInfo.createdAt,
            lastUsed: resourceInfo.lastUsed
        };
    }

    async onShutdown() {
        // Clean up all port-forward processes
        for (const portForwardProcess of this.portForwardProcesses.values()) {
            if (portForwardProcess && !portForwardProcess.killed) {
                portForwardProcess.kill('SIGTERM');
            }
        }
        this.portForwardProcesses.clear();
    }

    async createOrUpdateConfigMap(scriptDirPath, scriptFiles = ['index.js']) {
        await this.initialize();

        logger.info(`Creating ConfigMap from scripts in: ${scriptDirPath}`);
        logger.info(`Script files: ${scriptFiles.join(', ')}`);

        const configMapData = {};

        // Add all script files to ConfigMap
        for (const scriptFile of scriptFiles) {
            const scriptPath = path.join(scriptDirPath, scriptFile);
            logger.info(`Checking script file: ${scriptPath}`);
            if (fs.existsSync(scriptPath)) {
                configMapData[scriptFile] = fs.readFileSync(scriptPath, 'utf8');
                logger.info(`Added ${scriptFile} to ConfigMap`);
            } else {
                logger.warn(`Script file not found: ${scriptPath}`);
            }
        }

        // Add package.json
        configMapData['package.json'] = JSON.stringify({
            name: 'my-app',
            dependencies: { express: '^4.18.2' }
        });
        logger.info('Added package.json to ConfigMap');

        const configMapManifest = {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            metadata: {
                name: 'scripts',
                namespace: this.namespace
            },
            data: configMapData
        };

        logger.info(`ConfigMap data keys: ${Object.keys(configMapData).join(', ')}`);

        try {
            // Try to read existing ConfigMap
            logger.info(`Checking if ConfigMap 'scripts' exists in namespace '${this.namespace}'`);
            await this.k8sApi.readNamespacedConfigMap({ namespace: this.namespace, name: 'scripts' });
            // If it exists, update it
            logger.info('ConfigMap exists, updating...');
            await this.k8sApi.replaceNamespacedConfigMap({
                namespace: this.namespace,
                name: 'scripts',
                body: configMapManifest
            });
            logger.info('ConfigMap updated successfully');
        } catch (err) {
            logger.info('>>>>>ConfigMap does not exist or error reading it:', err.code);
            if (err.code === 404) {
                // ConfigMap doesn't exist, create it
                logger.info('ConfigMap not found, creating new one...');
                try {
                    await this.k8sApi.createNamespacedConfigMap({
                        namespace: this.namespace,
                        body: configMapManifest
                    });
                    logger.info('ConfigMap created successfully');
                } catch (createErr) {
                    logger.error('Failed to create ConfigMap:', createErr.message);
                    throw createErr;
                }
            } else {
                logger.error('Error reading ConfigMap:', err.message);
                logger.error('Error reading ConfigMap:', JSON.stringify(err));
                throw err;
            }
        }
    }

    async getOrCreatePodInPool(scriptDirPath, scriptFiles = ['index.js']) {
        await this.initialize();

        if (this.isShuttingDown) {
            throw new Error('K8sManager is shutting down');
        }

        if (!scriptDirPath) {
            throw new Error('Script directory path is required');
        }

        this.updateLastRequestTime();
        await this.startPoolWatcher();

        if (this.canCreateNewResource()) {
            try {
                await this.createOrUpdateConfigMap(scriptDirPath, scriptFiles);
            } catch (configMapErr) {
                logger.error('Failed to create/update ConfigMap:', configMapErr.message);
                throw new Error(`ConfigMap creation failed: ${configMapErr.message}`);
            }

            try {
                const port = await getAvailablePort();
                const podName = `${this.defaultPodName}-${port}-${Date.now()}`;
                await this.createPod(port, podName);

                // Double-check pool size in case it changed during async operation
                if (this.canCreateNewResource()) {
                    const podInfo = {
                        name: podName,
                        port,
                        createdAt: Date.now(),
                        lastUsed: Date.now()
                    };
                    this.addToPool(podInfo);
                    logger.info(`Started pod: ${podName} (port ${port})`);
                } else {
                    // Pool filled up while we were creating, terminate this pod
                    await this.terminateResource({ name: podName, port });
                }
            } catch (err) {
                if (this.pool.length === 0) {
                    logger.warn('Pod creation failed and pool is empty:', err.message);
                    throw err;
                }
                logger.warn('Pod creation failed, using existing pod from pool:', err.message);
            }
        }

        if (this.pool.length === 0) {
            throw new Error('No pods available in pool');
        }

        // Round-robin selection with liveness check
        const selectedPod = this.selectFromPool();

        if (selectedPod) {
            // Verify pod is still running
            const isAlive = await this.isResourceAlive(selectedPod);

            if (isAlive) {
                selectedPod.lastUsed = Date.now();
                return { name: selectedPod.name, port: selectedPod.port };
            } else {
                logger.warn(`Pod ${selectedPod.name} is not running, removing from pool`);
                this.removePodFromPool(selectedPod.name);

                // Recursively try again with remaining pods
                if (this.pool.length > 0) {
                    return this.getOrCreatePodInPool(scriptDirPath, scriptFiles);
                }
                throw new Error('No pods available in pool after health check');
            }
        }

        throw new Error('No pods available in pool');
    }

    async createPod(port = 8080, podName = null) {
        await this.initialize();

        podName = podName || this.defaultPodName;

        return new Promise(async (resolve, reject) => {
            let isResolved = false;
            const timeoutId = setTimeout(() => {
                if (!isResolved) {
                    isResolved = true;
                    reject(new Error(`Pod creation timeout after ${this.podTimeout}ms`));
                }
            }, this.podTimeout);

            try {
                const result = await this._createPodInternal(port, podName);
                if (!isResolved) {
                    isResolved = true;
                    clearTimeout(timeoutId);
                    resolve(result);
                }
            } catch (err) {
                if (!isResolved) {
                    isResolved = true;
                    clearTimeout(timeoutId);
                    reject(err);
                }
            }
        });
    }

    async _createPodInternal(port, podName) {
        const podManifest = {
            apiVersion: 'v1',
            kind: 'Pod',
            metadata: {
                name: podName,
                labels: {
                    app: 'my-app',
                },
            },
            spec: {
                containers: [
                    {
                        name: 'my-container',
                        image: 'node:18-alpine',
                        ports: [{ containerPort: this.defaultPodPort }],
                        workingDir: '/app',
                        volumeMounts: [
                            {
                                name: 'app-scripts',
                                mountPath: '/scripts',
                                readOnly: true
                            }
                        ],
                        command: ['sh', '-c'],
                        args: [
                            'cp -L -r /scripts/* /app/ && npm install --omit=dev --no-audit --no-fund && exec node index.js'
                        ],
                        env: [
                            {
                                name: 'PORT',
                                value: String(this.defaultPodPort)
                            },
                            {
                                name: 'NODE_ENV',
                                value: 'production'
                            }
                        ]
                    },
                ],
                volumes: [
                    {
                        name: 'app-scripts',
                        configMap: {
                            name: 'scripts',
                            defaultMode: 0o755
                        }
                    }
                ],
            },
        };

        logger.info(`Attempting to create Pod in namespace: ${this.namespace}`);
        try {
            const res = await this.k8sApi.createNamespacedPod({
                namespace: this.namespace,
                body: podManifest
            });

            // Wait for pod to be ready (status.phase === 'Running')
            let isReady = false;
            for (let i = 0; i < 30; i++) {
                const podStatus = await this.k8sApi.readNamespacedPod({
                    namespace: this.namespace,
                    name: podName
                });
                if (podStatus.status && podStatus.status.phase === 'Running') {
                    isReady = true;
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, 500));
            }

            if (!isReady) {
                throw new Error(`Pod "${podName}" did not become ready in time.`);
            }
            logger.info(`Pod "${podName}" is running.`);

            // Port-forward defaultPodPort to the requested port
            const portForwardProcess = spawn('kubectl', [
                'port-forward',
                `pod/${podName}`,
                `${port}:${this.defaultPodPort}`,
                '-n',
                this.namespace
            ]);

            // Optionally, handle port-forward process events
            portForwardProcess.stdout.on('data', data => {
                logger.info(`kubectl port-forward stdout: ${data}`);
            });
            portForwardProcess.stderr.on('data', data => {
                logger.error(`kubectl port-forward stderr: ${data}`);
            });

            // Track port-forward process for cleanup
            this.portForwardProcesses.set(podName, portForwardProcess);

            return { status: 'started', name: podName, pod: res.body, portForwardProcess };
        } catch (err) {
            throw err;
        }
    }

    removePodFromPool(podName) {
        const removed = this.removeFromPool(podName);

        if (removed) {
            // Clean up port-forward process
            const portForwardProcess = this.portForwardProcesses.get(podName);
            if (portForwardProcess && !portForwardProcess.killed) {
                portForwardProcess.kill('SIGTERM');
                this.portForwardProcesses.delete(podName);
            }
        }

        return removed;
    }

    async deletePod(podName = null) {
        await this.initialize();

        podName = podName || this.defaultPodName;

        try {
            await this.k8sApi.deleteNamespacedPod({
                namespace: this.namespace,
                name: podName
            });
            return { status: 'stopped and removed', name: podName };
        } catch (err) {
            if (err.response && err.response.statusCode === 404) {
                return { status: 'pod not found', name: podName };
            }
            throw err;
        }
    }

    getPoolInfo() {
        const info = super.getPoolInfo();
        // Return with 'pods' instead of 'resources' for backward compatibility
        const { resources, ...rest } = info;
        return {
            ...rest,
            pods: resources
        };
    }

    async shutdown() {
        if (this.isShuttingDown) {
            return;
        }

        logger.info('K8sManager shutting down...');
        this.isShuttingDown = true;

        // Stop pool watcher
        this.stopPoolWatcher();

        // Terminate all pods
        await this.stopAllPods();

        // Call onShutdown hook for cleanup
        await this.onShutdown();

        logger.info('K8sManager shutdown complete');
    }

    async stopAllPods() {
        if (this.pool.length === 0) {
            logger.info('No pods to stop');
            return;
        }

        const promises = this.pool.map(async (podInfo) => {
            try {
                await this.terminatePod(podInfo);
            } catch (err) {
                logger.error(`Error stopping pod ${podInfo.name}:`, err.message);
            }
        });

        await Promise.allSettled(promises);
        this.clearPool();
    }
}

module.exports = K8sManager;