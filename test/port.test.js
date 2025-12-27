const net = require('net');
const { getAvailablePort } = require('../lib/utils/port');

describe('Port Utils', () => {
    test('should return a valid port number', async () => {
        const port = await getAvailablePort();
        expect(typeof port).toBe('number');
        expect(port).toBeGreaterThan(0);
        expect(port).toBeLessThan(65536);
    });

    test('should return a port that is actually free', async () => {
        const port = await getAvailablePort();

        // Try to start a server on that port to verify it's free
        const server = net.createServer();

        await new Promise((resolve, reject) => {
            server.listen(port, () => {
                server.close(() => resolve());
            });
            server.on('error', (err) => {
                reject(new Error(`Port ${port} was not free: ${err.message}`));
            });
        });
    });

    test('should handle errors gracefully', async () => {
        // Mock net.createServer to throw an error
        const originalCreateServer = net.createServer;
        const mockError = new Error('Network error');

        net.createServer = jest.fn(() => ({
            listen: jest.fn(),
            on: jest.fn((event, callback) => {
                if (event === 'error') {
                    callback(mockError);
                }
            })
        }));

        await expect(getAvailablePort()).rejects.toThrow('Network error');

        // Restore mock
        net.createServer = originalCreateServer;
    });
});
