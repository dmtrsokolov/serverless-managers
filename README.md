# Serverless Managers

[![Node.js CI](https://github.com/kloudough/serverless-managers/workflows/CI/badge.svg)](https://github.com/kloudough/serverless-managers/actions)
[![codecov](https://codecov.io/gh/kloudough/serverless-managers/branch/main/graph/badge.svg)](https://codecov.io/gh/kloudough/serverless-managers)
[![npm version](https://badge.fury.io/js/serverless-managers.svg)](https://badge.fury.io/js/serverless-managers)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)

**Node.js library for managing serverless resources** - Docker containers, Kubernetes pods, Node.js processes, and worker threads with built-in pooling, health checks, and graceful shutdown.

## 🚀 Features

- **🐳 Docker Container Management** - Pool-based container lifecycle with automatic health checks
- **☸️ Kubernetes Pod Management** - Scalable pod orchestration with graceful shutdown
- **⚙️ Process Management** - Node.js child process pooling with resource limits
- **🧵 Worker Thread Management** - Thread-safe worker pools for CPU-intensive tasks
- **🔄 Resource Pooling** - Pre-warmed resources for instant execution
- **🏥 Health Monitoring** - Automatic resource health checks and recovery
- **🛡️ Graceful Shutdown** - Clean resource cleanup on termination signals
- **⏱️ Timeout Management** - Configurable timeouts with automatic cleanup

---

## 📋 Table of Contents

- [Quick Start](#quick-start)
- [Installation](#installation)
- [Usage](#usage)
  - [Docker Manager](#docker-manager)
  - [Kubernetes Manager](#kubernetes-manager)
  - [Process Manager](#process-manager)
  - [Worker Manager](#worker-manager)
- [API Reference](#api-reference)
- [Testing](#testing)
- [CI/CD Pipeline](#cicd-pipeline)
- [Contributing](#contributing)
- [License](#license)

---

## ⚡ Quick Start

```javascript
const { DockerManager, K8sManager, ProcessManager, WorkerManager } = require('serverless-managers');

// Docker containers
const dockerMgr = new DockerManager({
  defaultImageName: 'my-image:latest',
  scriptDirPath: './',
  scriptFiles: ['index.js'],
  minPoolSize: 2 
});
await dockerMgr.init();
const container = await dockerMgr.getOrCreateContainerInPool();

// Kubernetes pods
const k8sMgr = new K8sManager({
  defaultPodName: 'my-pod',
  namespace: 'default',
  scriptDirPath: './',
  scriptFiles: ['script.js'],
  minPoolSize: 2
});
await k8sMgr.init();
const pod = await k8sMgr.getOrCreatePodInPool();

// Node.js processes
const processMgr = new ProcessManager({
  scriptDirPath: './',
  scriptFiles: ['myScript.js'],
  minPoolSize: 3
});
await processMgr.init();
const process = await processMgr.getOrCreateProcessInPool();

// Worker threads
const workerMgr = new WorkerManager({
  scriptDirPath: './',
  scriptFiles: ['worker.js'],
  minPoolSize: 4
});
await workerMgr.init();
const worker = await workerMgr.getOrCreateWorkerInPool();
```

---

## 📦 Installation

### Prerequisites

- **Node.js** 18+ (LTS recommended)
- **npm** or **yarn**
- **Docker** (for DockerManager)
- **kubectl** + Kubernetes cluster access (for K8sManager)

### Install

```bash
npm install serverless-managers
```

### Verify Installation

```bash
npm test
```

Expected output: `Tests: 169 passed, 169 total` ✅

---

## 🎯 Usage

### Docker Manager

Manage Docker containers with automatic pooling and health checks.

```javascript
const { DockerManager } = require('serverless-managers');

const dockerManager = new DockerManager({
  defaultImageName: 'node:18-alpine',
  scriptDirPath: './',
  scriptFiles: ['index.js'],
  minPoolSize: 2,
  maxPoolSize: 10,
  healthCheckInterval: 30000, // 30 seconds
  containerTimeout: 60000      // 60 seconds
});

await dockerManager.init();

// Get or create container
const container = await dockerManager.getOrCreateContainerInPool();
console.log('Container ID:', container.id);

// Health check
const isHealthy = await dockerManager.healthCheck();
console.log('All containers healthy:', isHealthy);

// Cleanup
await dockerManager.shutdown();
```

**Key Features:**
- Automatic container creation and pooling
- Health monitoring with configurable intervals
- Graceful shutdown with SIGTERM/SIGINT handling
- Port forwarding support
- Configurable resource limits

[📖 Full Docker Manager Documentation](./docs/DOCKER_MANAGER.md)

---

### Kubernetes Manager

Orchestrate Kubernetes pods with round-robin selection and lifecycle management.

```javascript
const { K8sManager } = require('serverless-managers');

const k8sManager = new K8sManager({
  defaultPodName: 'my-worker-pod',
  namespace: 'default',
  scriptDirPath: './',
  scriptFiles: ['serverless-job.js'],
  minPoolSize: 3,
  maxPoolSize: 20,
  podTimeout: 60000,    // 60 seconds
  shutdownTimeout: 15000 // 15 seconds
});

await k8sManager.init();

// Get pod (round-robin selection)
const pod = await k8sManager.getOrCreatePodInPool();
console.log('Pod name:', pod.metadata.name);

// Health check with dead pod removal
const healthyPods = await k8sManager.healthCheck();
console.log('Healthy pods:', healthyPods);

// Cleanup with force delete fallback
await k8sManager.shutdown();
```

**Key Features:**
- Round-robin pod selection for load distribution
- Pod liveness checks via Kubernetes API
- Force delete with `gracePeriodSeconds: 0` fallback
- kubectl port-forward process tracking and cleanup
- Automatic shutdown handler registration

[📖 Full K8s Manager Documentation](./K8S_OPTIMIZATIONS.md)

---

### Process Manager

Manage Node.js child processes with resource pooling and restart capabilities.

```javascript
const { ProcessManager } = require('serverless-managers');

const processManager = new ProcessManager({
  scriptDirPath: './',
  scriptFiles: ['myScript.js'],
  minPoolSize: 3,
  maxPoolSize: 15,
  healthCheckInterval: 20000, // 20 seconds
  processTimeout: 45000        // 45 seconds
});

await processManager.init();

// Get process from pool
const process = await processManager.getOrCreateProcessInPool();
console.log('Process PID:', process.pid);

// Send message to process
process.send({ task: 'compute', data: [1, 2, 3] });

// Listen for response
process.on('message', (msg) => {
  console.log('Result:', msg);
});

// Cleanup
await processManager.shutdown();
```

**Key Features:**
- Child process pooling with automatic restarts
- Inter-process communication (IPC)
- Resource limit enforcement
- Health monitoring
- Graceful shutdown with cleanup

[📖 Full Process Manager Documentation](./docs/PROCESS_MANAGER.md)

---

### Worker Manager

Manage worker threads for CPU-intensive tasks with thread-safe operations.

```javascript
const { WorkerManager } = require('serverless-managers');

const workerManager = new WorkerManager({
  scriptDirPath: './',
  scriptFiles: ['cpuIntensiveTask.js'],
  minPoolSize: 4,
  maxPoolSize: 8,
  workerData: { config: 'value' },
  healthCheckInterval: 15000 // 15 seconds
});

await workerManager.init();

// Get worker from pool
const worker = await workerManager.getOrCreateWorkerInPool();

// Post task to worker
worker.postMessage({ operation: 'factorial', n: 100000 });

// Handle result
worker.on('message', (result) => {
  console.log('Computed result:', result);
});

// Cleanup
await workerManager.shutdown();
```

**Key Features:**
- Worker thread pooling for parallel CPU tasks
- SharedArrayBuffer support
- Automatic worker restart on error
- Memory-efficient for CPU-bound operations
- Graceful termination

[📖 Full Worker Manager Documentation](./docs/WORKER_MANAGER.md)

---

## 📚 API Reference

### Common Options (All Managers)

```javascript
{
  scriptDirPath: './',       // Path to directory containing scripts (required)
  scriptFiles: ['index.js'], // List of script files to include (required)
  minPoolSize: 2,           // Minimum pool size (default: 2)
  maxPoolSize: 10,          // Maximum pool size (default: 10)
  healthCheckInterval: 30000, // Health check interval in ms
  shutdownTimeout: 15000     // Graceful shutdown timeout in ms
}
```

### Manager-Specific Options

#### DockerManager
```javascript
{
  containerTimeout: 60000,  // Container creation timeout
  portBindings: {},         // Port mappings
  env: [],                  // Environment variables
  cmd: []                   // Container command override
}
```

#### K8sManager
```javascript
{
  podTimeout: 60000,        // Pod creation timeout
  namespace: 'default',     // Kubernetes namespace
  image: 'node:18-alpine',  // Container image
  replicas: 3               // Desired replicas
}
```

#### ProcessManager
```javascript
{
  processTimeout: 45000,    // Process spawn timeout
  cwd: './',                // Working directory
  env: process.env,         // Environment variables
  maxBuffer: 1024 * 1024    // stdout/stderr buffer size
}
```

#### WorkerManager
```javascript
{
  workerData: {},           // Initial worker data
  resourceLimits: {         // Worker resource limits
    maxOldGenerationSizeMb: 512,
    maxYoungGenerationSizeMb: 128
  }
}
```

### Common Methods

All managers implement:

```javascript
// Initialize manager and create initial pool
await manager.init();

// Get or create resource from pool
const resource = await manager.getOrCreateResourceInPool();

// Check health and remove unhealthy resources
const isHealthy = await manager.healthCheck();

// Gracefully shutdown and cleanup all resources
await manager.shutdown();

// Get current pool status
const status = manager.getPoolStatus();
// Returns: { total: 5, healthy: 4, unhealthy: 1 }
```

---

## 🧪 Testing

### Run All Tests

```bash
npm test
```

### Run Specific Manager Tests

```bash
npm test -- docker.test.js
npm test -- k8s.test.js
npm test -- process.test.js
npm test -- worker.test.js
```

### Coverage Report

```bash
npm run test:coverage
```

### Test Statistics

- ✅ **169 total tests** (all passing)
- ✅ **Worker Manager**: 41 tests
- ✅ **Process Manager**: 33 tests
- ✅ **Docker Manager**: 37 tests
- ✅ **K8s Manager**: 58 tests

---

## 🔧 CI/CD Pipeline

This project includes a comprehensive GitHub Actions pipeline:

### Workflows

1. **CI Workflow** - Multi-version Node.js testing (18, 20, 22)
2. **Release Workflow** - Automated releases with changelog
3. **CodeQL Workflow** - Security vulnerability scanning
4. **Dependency Review** - PR dependency security checks

### Quick Setup

```bash
# 1. Configure secrets (optional)
# Repository Settings → Secrets → Actions
# Add: CODECOV_TOKEN (for coverage), NPM_TOKEN (for publishing)

# 2. Enable workflows
# Actions → Enable workflows

# 3. Configure branch protection
# Settings → Branches → Add rule for 'main'
```

[📖 Complete CI/CD Documentation](./CICD_SETUP.md)

### Badges

Add to your repository:

```markdown
![CI](https://github.com/kloudough/serverless-managers/workflows/CI/badge.svg)
![CodeQL](https://github.com/kloudough/serverless-managers/workflows/CodeQL/badge.svg)
```

---

## 📄 License

This project is licensed under the **MIT License** - see the [LICENSE](LICENSE) file for details.

### What This Means

✅ **You CAN:**
- Use this library commercially
- Modify and distribute the code
- Use it in proprietary software
- Sublicense it
- Use it privately

❌ **You CANNOT:**
- Hold the authors liable
- Use contributors' names for endorsement

📋 **You MUST:**
- Include the original license and copyright notice in any copy of the software

### Why MIT?

We chose the MIT License because:
- **Maximum freedom** for developers and enterprises
- **Simple and permissive** - widely understood and trusted
- **npm ecosystem standard** - most compatible with other packages
- **Enterprise-friendly** - no copyleft restrictions
- **Encourages adoption** - minimal barriers to use

### Third-Party Licenses

This project depends on several open-source libraries. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for details.

---

## 🤝 Contributing

Contributions are welcome! Please read our [Contributing Guide](.github/CONTRIBUTING.md) for details on:
- Code of conduct
- Development process
- Pull request process
- Coding standards

By contributing, you agree that your contributions will be licensed under the MIT License.
