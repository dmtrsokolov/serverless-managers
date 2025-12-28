const express = require('express');
const http = require('http');
const { DockerManager, K8sManager, ProcessManager, WorkerManager } = require('../lib');
const greet = require('./scripts/greet');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize managers
const scriptDirPath = `${__dirname}/scripts`;
const scriptFiles = ['index.js', 'greet.js'];
const managerConfig = { scriptDirPath, scriptFiles };

const dockerManager = new DockerManager(managerConfig);
const k8sManager = new K8sManager(managerConfig);
const processManager = new ProcessManager(managerConfig);
const workerManager = new WorkerManager(managerConfig);

app.get('/', (req, res) => {
    res.send(greet('World'));
});

app.get('/docker', async (req, res) => {
    try {
        const { name: containerName, port } = await dockerManager.getOrCreateContainerInPool();
        http.get(`http://localhost:${port}/`, (response) => {
            let data = '';
            response.on('data', chunk => data += chunk);
            response.on('end', async () => {
                res.json({ containerResponse: data, port, containerName });
            });
        }).on('error', async (err) => {
            res.status(500).json({ error: err.message });
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/process', async (req, res) => {
    try {
        let processs = await processManager.getOrCreateProcessInPool();
        const { port, name: processName } = processs;
        http.get(`http://localhost:${port}/`, (response) => {
            let data = '';
            response.on('data', chunk => data += chunk);
            response.on('end', () => {
                res.json({ childResponse: data, processName, port });
            });
        }).on('error', (err) => {
            res.status(500).json({ error: err.message });
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/worker', async (req, res) => {
    try {
        let worker = await workerManager.getOrCreateWorkerInPool();
        const { port, name: workerName } = worker;
        await new Promise(resolve => setTimeout(resolve, 1000));
        http.get(`http://localhost:${port}/`, (response) => {
            let data = '';
            response.on('data', chunk => data += chunk);
            response.on('end', () => {
                res.json({ workerResponse: data, workerName, port });
            });
        }).on('error', (err) => {
            res.status(500).json({ error: err.message });
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/k8s', async (req, res) => {
    try {
        const { name: podName, port } = await k8sManager.getOrCreatePodInPool();
        http.get(`http://localhost:${port}/`, (response) => {
            let data = '';
            response.on('data', chunk => data += chunk);
            response.on('end', async () => {
                res.json({ podResponse: data, port, podName });
            });
        }).on('error', async (err) => {
            res.status(500).json({ error: err.message });
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/metrics', (req, res) => {
    res.set('Content-Type', 'text/plain');
    const workerManagerMetrics = workerManager.getPrometheusMetrics();
    const processManagerMetrics = processManager.getPrometheusMetrics();
    const dockerManagerMetrics = dockerManager.getPrometheusMetrics();
    const k8sManagerMetrics = k8sManager.getPrometheusMetrics();
    const metrics = `${workerManagerMetrics}\n${processManagerMetrics}\n${dockerManagerMetrics}\n${k8sManagerMetrics}`;
    res.send(metrics);
});

app.listen(PORT, () => {
    console.log(`Example server running on http://localhost:${PORT}`);
});