const http = require('http');
const greet = require('./greet');
const { workerData } = require('worker_threads');

const port =
    (workerData && workerData.port) ||
    process.argv[2] ||
    8080;

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(greet('World from anotherApp.js!'));
});

server.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
