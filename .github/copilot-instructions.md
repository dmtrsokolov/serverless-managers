# Copilot Coding Agent Onboarding Instructions

## High-Level Repository Overview

This repository provides a **Node.js library for managing serverless resources** such as Docker containers, Kubernetes pods, Node.js processes, and worker threads. The core logic is implemented as a reusable library in `lib/`, while `examples/` and `src/` provide sample scripts and usage patterns. The project is intended for use as a backend utility or as a base for serverless orchestration and management.

- **Primary language:** JavaScript (Node.js)
- **Frameworks:** None required, but uses `express` for sample servers and `jest` for testing.
- **Target runtime:** Node.js 18+ (recommended)
- **Repository size:** Small to medium (core library, examples, and tests)
- **Key dependencies:** `dockerode`, `@kubernetes/client-node`, `express`, `jest`

## Architecture & Design Patterns

- **Inheritance-based managers:** All resource managers (`DockerManager`, `K8sManager`, `ProcessManager`, `WorkerManager`) extend `BaseServerlessManager` in `lib/managers/base.js`, implementing abstract methods like `getResourceType()`, `isResourceAlive()`, and `terminateResource()`.
- **Pool management:** Common pattern across managers with configurable `maxPoolSize`, idle resource cleanup via pool watcher (removes resources after `poolCheckInterval`), and round-robin selection for load distribution.
- **Resource lifecycle:** Each manager handles creation, health checks, and graceful shutdown. Example: `DockerManager.getOrCreateContainerInPool(scriptDirPath, scriptFiles)` binds script files to container and starts on available port.
- **Integration points:** Uses `dockerode` for Docker API, `@kubernetes/client-node` for K8s, `child_process.spawn` for processes, `worker_threads` for workers. Port allocation via `lib/utils/port.js`.
- **Backward compatibility:** Managers like `DockerManager` provide aliases (e.g., `containerPool` for `pool`, `terminateContainer` for `terminateResource`).

## Build, Test, and Validation Instructions

### Environment Setup

- **Always run `npm install` before building or testing.**
- Node.js 18+ is recommended for compatibility with worker threads and modern syntax.
- Docker and Kubernetes (kubectl, cluster access) are required for full integration testing, but not for unit tests.

### Bootstrap

```bash
npm install
```
- Installs all dependencies. Must be run after cloning or after any dependency changes.

### Build

- **No build step is required** for pure JavaScript. If you add TypeScript or a build tool, document the steps here.

### Test

```bash
npm test
```
- Runs all Jest unit tests in the `test/` directory.
- To run a specific test file:
  ```bash
  npm test test/process.test.js
  ```
- To run tests in watch mode:
  ```bash
  npm run test:watch
  ```
- To run with coverage:
  ```bash
  npm run test:coverage
  ```

**Note:**  
- If you add new test files, ensure they are named `*.test.js` and placed in the `test/` directory.
- Tests are self-contained and mock external dependencies (e.g., Docker, child_process).

### Run Example Server

```bash
node examples/server.js
```
- Starts the sample Express server using the library.
- Endpoints demonstrate Docker, K8s, process, and worker management.

### Lint

- No linter is configured by default. If you add ESLint or similar, document the usage here.

### Cleaning

- No explicit clean script. Remove `node_modules` and reinstall if you encounter dependency issues:
  ```bash
  rm -rf node_modules
  npm install
  ```

### Common Issues & Workarounds

- **Docker/Kubernetes integration:**  
  For integration tests or real resource management, ensure Docker is running and you have access to a Kubernetes cluster.
- **Timeouts in Jest:**  
  If a test times out, check for missing mocks or long-running async code. Increase timeout only if necessary.
- **Environment variables:**  
  Not required by default, but may be needed for advanced Docker/K8s usage.

## Project Layout & Architecture

### Directory Structure

```
lib/
  index.js                # Main library entry point
  managers/
    base.js               # BaseServerlessManager class with pool logic
    docker.js             # DockerManager class
    k8s.js                # K8sManager class
    process.js            # ProcessManager class
    worker.js             # WorkerManager class
  utils/
    port.js               # getAvailablePort utility

examples/
  server.js               # Sample Express server using the library
  scripts/
    greet.js              # Example utility
    index.js              # Example script

test/
  *.test.js               # Jest unit tests for each manager
```

### Key Files

- **`lib/index.js`**: Exports all managers and utilities for library consumers.
- **`lib/managers/base.js`**: Defines common pool management, shutdown handlers, and abstract methods for subclasses.
- **`lib/managers/*.js`**: Each manager encapsulates pooling, lifecycle, and cleanup logic for its resource type.
- **`lib/utils/port.js`**: Utility for finding available ports.
- **`examples/server.js`**: Demonstrates how to use the library in an Express app.
- **`test/*.test.js`**: Jest unit tests with mocked dependencies.

### Configuration Files

- **`package.json`**: Scripts for test, coverage, and example server.
- **No `.env`, `.eslintrc`, or CI/CD config by default.** Add and document if needed.

### Validation & CI

- **No GitHub Actions or CI/CD pipeline is present by default.**
- **Validation steps:**  
  - Always run `npm install` before testing or running.
  - Run `npm test` and ensure all tests pass before submitting changes.
  - If you add CI, ensure it runs `npm install` and `npm test`.

### Adding New Features

- Add new resource managers to `lib/managers/` by extending `BaseServerlessManager`.
- Implement abstract methods: `getResourceType()`, `isResourceAlive()`, `terminateResource()`.
- Add new utilities to `lib/utils/`.
- Add new sample usage to `examples/`.
- Add new tests to `test/`, using Jest and mocking external dependencies.

## Additional Guidance

- **Trust these instructions** for build, test, and run steps. Only search the codebase if information here is incomplete or in error.
- **Do not modify files in `src/`** unless specifically updating legacy examples.
- **Always update or add tests in `test/`** when changing library logic.
- **Document any new dependencies or scripts** in this file and in `package.json`.
- **License:** This project uses the MIT License. All contributions must be compatible with MIT.
- **Contributing:** See [CONTRIBUTING.md](.github/CONTRIBUTING.md) for guidelines.

---

## License & Legal

### MIT License

This project is licensed under the **MIT License**, one of the most permissive and developer-friendly open-source licenses.

**Why MIT?**
- ✅ Maximum freedom for users and contributors
- ✅ Enterprise-friendly (no copyleft restrictions)
- ✅ Simple and widely understood
- ✅ Standard for Node.js libraries
- ✅ Compatible with most other licenses

**What This Means for Contributors:**
- Your contributions will be licensed under MIT
- You retain copyright to your contributions
- Your code can be used commercially by others
- No CLA (Contributor License Agreement) required

**Files:**
- [LICENSE](../LICENSE) - Full license text
- [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) - Third-party licenses
- [CONTRIBUTING.md](.github/CONTRIBUTING.md) - Contribution guidelines

**Summary:**  
This repo is a Node.js library for managing serverless resources (Docker, K8s, processes, workers) with a clear separation between core logic (`lib/`), examples (`examples/`), and tests (`test/`). Use `npm install` and `npm test` as your primary validation steps. Follow the structure and conventions above for efficient and reliable contributions.

The project is MIT-licensed for maximum flexibility and adoption.