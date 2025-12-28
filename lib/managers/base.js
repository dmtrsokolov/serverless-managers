/**
 * Base class for all serverless managers
 * Provides common pool management, lifecycle, and shutdown logic
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const logger = require('../utils/logger');

class BaseServerlessManager {
    constructor(options = {}) {
        // Common configuration options
        this.maxPoolSize = options.maxPoolSize || 3;
        this.poolCheckInterval = options.poolCheckInterval || 10000; // 10 seconds
        this.shutdownTimeout = options.shutdownTimeout || 10000; // Default 10 seconds

        // Pool management
        this.pool = [];
        this.lastRequestTime = Date.now();
        this.watcherStarted = false;
        this.watcherInterval = null;
        this.isShuttingDown = false;

        // Graceful shutdown handling
        this.setupShutdownHandlers();

        // Metrics collection
        this.metrics = {
            requests: 0,
            hits: 0,
            misses: 0,
            additions: 0,
            evictions: 0,
            removals: 0
        };

        // Resource monitoring
        this.resourceMonitorInterval = null;
        this.resourceMetrics = {};
    }

    /**
     * Load configuration from file
     * @param {string} configPath Path to configuration file
     * @returns {Object} Configuration object
     */
    static loadConfig(configPath) {
        if (!fs.existsSync(configPath)) {
            throw new Error(`Configuration file not found: ${configPath}`);
        }

        const fileContent = fs.readFileSync(configPath, 'utf8');
        const ext = path.extname(configPath).toLowerCase();

        try {
            if (ext === '.json') {
                return JSON.parse(fileContent);
            } else if (ext === '.yml' || ext === '.yaml') {
                return yaml.load(fileContent);
            } else {
                throw new Error(`Unsupported configuration format: ${ext}`);
            }
        } catch (err) {
            throw new Error(`Failed to parse configuration file: ${err.message}`);
        }
    }

    /**
     * Create instance from configuration file
     * @param {string} configPath Path to configuration file
     * @returns {BaseServerlessManager} New instance
     */
    static fromConfig(configPath) {
        const config = this.loadConfig(configPath);
        return new this(config);
    }

    /**
     * Setup shutdown handlers for graceful shutdown
     * Common across all managers
     */
    setupShutdownHandlers() {
        this.shutdownHandler = () => {
            this.shutdown().catch(logger.error);
        };

        process.setMaxListeners(Math.max(process.getMaxListeners(), 20)); // Increase limit to avoid warnings in tests
        process.once('SIGINT', this.shutdownHandler);
        process.once('SIGTERM', this.shutdownHandler);
        process.once('beforeExit', this.shutdownHandler);
    }

    /**
     * Pool watcher that periodically removes idle resources
     * Common pattern across all managers
     */
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
                const resourceToRemove = this.pool.shift();
                if (resourceToRemove) {
                    this.metrics.evictions++;
                    await this.terminateResource(resourceToRemove);
                }
            }
        }, this.poolCheckInterval);

        // Use unref() to allow process to exit gracefully even if interval is active
        // This prevents timer leaks in tests and improves shutdown behavior
        if (this.watcherInterval && typeof this.watcherInterval.unref === 'function') {
            this.watcherInterval.unref();
        }
    }

    /**
     * Update the last request time (called when getting/creating resources)
     */
    updateLastRequestTime() {
        this.lastRequestTime = Date.now();
    }

    /**
     * Get pool size
     */
    getPoolSize() {
        return this.pool.length;
    }

    /**
     * Check if pool has space for new resources
     */
    canCreateNewResource() {
        return this.pool.length < this.maxPoolSize;
    }

    /**
     * Get pool information
     * Returns standardized pool info structure
     */
    getPoolInfo() {
        return {
            poolSize: this.pool.length,
            maxPoolSize: this.maxPoolSize,
            isShuttingDown: this.isShuttingDown,
            watcherStarted: this.watcherStarted,
            resources: this.pool.map(r => this.formatResourceInfo(r)),
            metrics: this.getMetrics()
        };
    }

    /**
     * Get current metrics
     */
    getMetrics() {
        return { ...this.metrics };
    }

    /**
     * Get metrics in Prometheus format
     * @returns {string} Prometheus metrics text
     */
    getPrometheusMetrics() {
        const metrics = this.getMetrics();
        const type = this.getResourceType();
        const labels = `{resource_type="${type}",manager="${this.constructor.name}"}`;
        const prefix = 'serverless_manager_pool';

        const lines = [];

        // Helper to add metric lines
        const addMetric = (name, help, type, value) => {
            const metricName = `${prefix}_${name}`;
            lines.push(`# HELP ${metricName} ${help}`);
            lines.push(`# TYPE ${metricName} ${type}`);
            lines.push(`${metricName}${labels} ${value}`);
        };

        addMetric('requests_total', 'Total number of pool acquisition requests', 'counter', metrics.requests);
        addMetric('hits_total', 'Total number of successful pool hits', 'counter', metrics.hits);
        addMetric('misses_total', 'Total number of pool misses', 'counter', metrics.misses);
        addMetric('additions_total', 'Total number of resources added to pool', 'counter', metrics.additions);
        addMetric('evictions_total', 'Total number of idle resources evicted', 'counter', metrics.evictions);
        addMetric('removals_total', 'Total number of resources removed from pool', 'counter', metrics.removals);

        // Gauge for current pool size
        addMetric('size', 'Current number of resources in pool', 'gauge', this.pool.length);

        return lines.join('\n');
    }

    /**
     * Clear the pool (but don't terminate resources)
     */
    clearPool() {
        this.pool = [];
        this.updateLastRequestTime();
    }

    /**
     * Start pool watcher if not already started
     */
    async startPoolWatcher() {
        if (!this.watcherStarted) {
            this.watcherStarted = true;
            await this.poolWatcher();
        }
    }

    /**
     * Add resource to pool
     */
    addToPool(resourceInfo) {
        if (this.pool.length < this.maxPoolSize) {
            this.pool.push(resourceInfo);
            this.metrics.additions++;
            return true;
        }
        return false;
    }

    /**
     * Remove resource from pool by name
     */
    removeFromPool(resourceName) {
        const index = this.pool.findIndex(r => r.name === resourceName);
        if (index !== -1) {
            const removed = this.pool.splice(index, 1)[0];
            this.metrics.removals++;
            logger.info(`${this.getResourceType()} ${resourceName} removed from pool`);
            return removed;
        }
        return null;
    }

    /**
     * Get resource from pool using round-robin selection
     */
    selectFromPool() {
        this.metrics.requests++;
        if (this.pool.length === 0) {
            this.metrics.misses++;
            return null;
        }

        // Use round-robin for better load distribution
        const resourceIndex = Math.floor(Date.now() / 1000) % this.pool.length;
        this.metrics.hits++;
        return this.pool[resourceIndex];
    }

    /**
     * Stop pool watcher
     */
    stopPoolWatcher() {
        if (this.watcherInterval) {
            clearInterval(this.watcherInterval);
            this.watcherInterval = null;
        }
    }

    /**
     * Stop all resources in the pool
     */
    async stopAllResources() {
        if (this.pool.length === 0) {
            logger.info(`No ${this.getResourceType()}s to stop`);
            return;
        }

        logger.info(`Stopping ${this.pool.length} ${this.getResourceType()}s...`);

        const terminatePromises = this.pool.map(resourceInfo =>
            this.terminateResource(resourceInfo).catch(err => {
                logger.error(`Error stopping ${this.getResourceType()} ${resourceInfo.name}:`, err.message);
            })
        );

        try {
            await Promise.allSettled(terminatePromises);
        } catch (err) {
            logger.error(`Error during ${this.getResourceType()} termination:`, err);
        }

        this.clearPool();
        logger.info(`All ${this.getResourceType()}s stopped`);
    }

    /**
     * Shutdown the manager gracefully
     */
    async shutdown() {
        if (this.isShuttingDown) {
            return;
        }

        logger.info(`${this.constructor.name} shutting down...`);
        this.isShuttingDown = true;

        // Stop monitors
        this.stopPoolWatcher();
        this.stopResourceMonitoring();

        // Stop all resources
        await this.stopAllResources();

        // Remove process event listeners
        if (this.shutdownHandler) {
            process.removeListener('SIGINT', this.shutdownHandler);
            process.removeListener('SIGTERM', this.shutdownHandler);
            process.removeListener('beforeExit', this.shutdownHandler);
        }

        // Call subclass cleanup hook if needed
        await this.onShutdown();

        logger.info(`${this.constructor.name} shutdown complete`);
    }

    /**
     * Start resource monitoring loop
     * @param {number} interval - Monitoring interval in ms
     */
    startResourceMonitoring(interval = 5000) {
        if (this.resourceMonitorInterval) {
            return; // Already started
        }

        this.resourceMonitorInterval = setInterval(async () => {
            if (this.isShuttingDown) {
                return;
            }
            await this.monitorResources();
        }, interval);

        if (this.resourceMonitorInterval && typeof this.resourceMonitorInterval.unref === 'function') {
            this.resourceMonitorInterval.unref();
        }
    }

    /**
     * Stop resource monitoring loop
     */
    stopResourceMonitoring() {
        if (this.resourceMonitorInterval) {
            clearInterval(this.resourceMonitorInterval);
            this.resourceMonitorInterval = null;
        }
    }

    /**
     * Monitor resources and update metrics
     */
    async monitorResources() {
        if (this.pool.length === 0) return;

        for (const resource of this.pool) {
            try {
                const usage = await this.getResourceUsage(resource);
                if (usage) {
                    this.resourceMetrics[resource.name] = {
                        ...usage,
                        timestamp: Date.now()
                    };
                }
            } catch (err) {
                // Ignore errors for individual resources to keep loop running
                // logger.debug(`Failed to get stats for ${resource.name}: ${err.message}`);
            }
        }
    }

    /**
     * Get resource usage stats (CPU, Memory)
     * @param {Object} resourceInfo 
     * @returns {Promise<Object>} { cpu: number, memory: number }
     */
    async getResourceUsage(resourceInfo) {
        // Default implementation does nothing
        return null;
    }

    /**
     * Health check - remove dead resources from pool
     */
    async healthCheck() {
        const deadResources = [];

        for (let i = this.pool.length - 1; i >= 0; i--) {
            const resourceInfo = this.pool[i];
            const isAlive = await this.isResourceAlive(resourceInfo);

            if (!isAlive) {
                deadResources.push(this.pool.splice(i, 1)[0]);
                // Also remove metrics
                delete this.resourceMetrics[resourceInfo.name];
            }
        }

        if (deadResources.length > 0) {
            logger.info(`Removed ${deadResources.length} dead ${this.getResourceType()}s from pool`);
        }

        return {
            [`total${this.getResourceTypeCapitalized()}s`]: this.pool.length,
            [`dead${this.getResourceTypeCapitalized()}sRemoved`]: deadResources.length,
            healthy: this.pool.length > 0 || !this.isShuttingDown
        };
    }

    // ========================================
    // Abstract methods - must be implemented by subclasses
    // ========================================

    /**
     * Get the resource type name (e.g., 'container', 'pod', 'process', 'worker')
     * @returns {string}
     */
    getResourceType() {
        throw new Error('getResourceType() must be implemented by subclass');
    }

    /**
     * Get the capitalized resource type name (e.g., 'Container', 'Pod')
     * @returns {string}
     */
    getResourceTypeCapitalized() {
        const type = this.getResourceType();
        return type.charAt(0).toUpperCase() + type.slice(1);
    }

    /**
     * Format resource info for getPoolInfo()
     * @param {Object} resourceInfo - The resource info object
     * @returns {Object} Formatted resource info
     */
    formatResourceInfo(resourceInfo) {
        const baseInfo = {
            name: resourceInfo.name,
            port: resourceInfo.port,
            createdAt: resourceInfo.createdAt,
            lastUsed: resourceInfo.lastUsed
        };

        // Add metrics if available
        if (this.resourceMetrics && this.resourceMetrics[resourceInfo.name]) {
            baseInfo.usage = this.resourceMetrics[resourceInfo.name];
        }

        return baseInfo;
    }

    /**
     * Check if a resource is still alive
     * @param {Object} resourceInfo - The resource info object
     * @returns {Promise<boolean>} True if resource is alive
     */
    async isResourceAlive(resourceInfo) {
        throw new Error('isResourceAlive() must be implemented by subclass');
    }

    /**
     * Terminate a resource gracefully
     * @param {Object} resourceInfo - The resource info object
     * @returns {Promise<void>}
     */
    async terminateResource(resourceInfo) {
        throw new Error('terminateResource() must be implemented by subclass');
    }

    /**
     * Hook called during shutdown for subclass-specific cleanup
     * @returns {Promise<void>}
     */
    async onShutdown() {
        // Default: no-op, can be overridden by subclasses
    }
}

module.exports = BaseServerlessManager;
