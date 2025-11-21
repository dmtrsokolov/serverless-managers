/**
 * Base class for all serverless managers
 * Provides common pool management, lifecycle, and shutdown logic
 */
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
    }

    /**
     * Setup shutdown handlers for graceful shutdown
     * Common across all managers
     */
    setupShutdownHandlers() {
        const shutdownHandler = () => {
            this.shutdown().catch(console.error);
        };
        
        process.once('SIGINT', shutdownHandler);
        process.once('SIGTERM', shutdownHandler);
        process.once('beforeExit', shutdownHandler);
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
            resources: this.pool.map(r => this.formatResourceInfo(r))
        };
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
            console.log(`Removed ${this.getResourceType()} ${resourceName} from pool`);
            return removed;
        }
        return null;
    }

    /**
     * Get resource from pool using round-robin selection
     */
    selectFromPool() {
        if (this.pool.length === 0) {
            return null;
        }
        
        // Use round-robin for better load distribution
        const resourceIndex = Math.floor(Date.now() / 1000) % this.pool.length;
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
            return;
        }

        console.log(`Stopping ${this.pool.length} ${this.getResourceType()}s...`);
        
        const terminatePromises = this.pool.map(resourceInfo => 
            this.terminateResource(resourceInfo)
        );
        
        try {
            await Promise.allSettled(terminatePromises);
        } catch (err) {
            console.error(`Error during ${this.getResourceType()} termination:`, err);
        }
        
        this.clearPool();
        console.log(`All ${this.getResourceType()}s stopped`);
    }

    /**
     * Shutdown the manager gracefully
     */
    async shutdown() {
        if (this.isShuttingDown) {
            return;
        }

        console.log(`${this.constructor.name} shutting down...`);
        this.isShuttingDown = true;

        // Stop the pool watcher
        this.stopPoolWatcher();

        // Stop all resources
        await this.stopAllResources();

        // Remove process event listeners
        process.removeAllListeners('SIGINT');
        process.removeAllListeners('SIGTERM');
        process.removeAllListeners('beforeExit');

        // Call subclass cleanup hook if needed
        await this.onShutdown();

        console.log(`${this.constructor.name} shutdown complete`);
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
            }
        }

        if (deadResources.length > 0) {
            console.log(`Removed ${deadResources.length} dead ${this.getResourceType()}s from pool`);
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
        return {
            name: resourceInfo.name,
            port: resourceInfo.port,
            createdAt: resourceInfo.createdAt,
            lastUsed: resourceInfo.lastUsed
        };
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
