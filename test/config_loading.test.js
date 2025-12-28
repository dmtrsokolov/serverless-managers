const fs = require('fs');
const path = require('path');
const BaseServerlessManager = require('../lib/managers/base');
const ProcessManager = require('../lib/managers/process');

describe('Configuration Loading', () => {
    const tempDir = path.join(__dirname, 'temp_config_test');

    beforeAll(() => {
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir);
        }
    });

    afterAll(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    afterEach(() => {
        // Clean up files created in each test if needed, or just rely on afterAll
    });

    test('should load valid JSON configuration', () => {
        const config = { maxPoolSize: 5, shutdownTimeout: 2000 };
        const configPath = path.join(tempDir, 'config.json');
        fs.writeFileSync(configPath, JSON.stringify(config));

        const loadedConfig = BaseServerlessManager.loadConfig(configPath);
        expect(loadedConfig).toEqual(config);
    });

    test('should load valid YAML configuration', () => {
        const yamlContent = 'maxPoolSize: 5\nshutdownTimeout: 2000';
        const configPath = path.join(tempDir, 'config.yaml');
        fs.writeFileSync(configPath, yamlContent);

        const loadedConfig = BaseServerlessManager.loadConfig(configPath);
        expect(loadedConfig).toEqual({ maxPoolSize: 5, shutdownTimeout: 2000 });
    });

    test('should throw error for non-existent file', () => {
        const configPath = path.join(tempDir, 'nonexistent.json');
        expect(() => {
            BaseServerlessManager.loadConfig(configPath);
        }).toThrow(/Configuration file not found/);
    });

    test('should throw error for unsupported extension', () => {
        const configPath = path.join(tempDir, 'config.txt');
        fs.writeFileSync(configPath, 'some text');
        expect(() => {
            BaseServerlessManager.loadConfig(configPath);
        }).toThrow(/Unsupported configuration format/);
    });

    test('should throw error for invalid JSON', () => {
        const configPath = path.join(tempDir, 'invalid.json');
        fs.writeFileSync(configPath, '{ invalid jsonStr... }'); // malformed
        expect(() => {
            BaseServerlessManager.loadConfig(configPath);
        }).toThrow(/Failed to parse configuration file/);
    });

    test('should throw error for invalid YAML', () => {
        const configPath = path.join(tempDir, 'invalid.yaml');
        fs.writeFileSync(configPath, '\tinvalid: yaml\n  - nesting error'); // tabs in yaml often cause issues or just bad structure
        expect(() => {
            BaseServerlessManager.loadConfig(configPath);
        }).toThrow(/Failed to parse configuration file/);
    });

    test('fromConfig should create instance with correct options', () => {
        const config = { maxPoolSize: 10, processTimeout: 5000 };
        const configPath = path.join(tempDir, 'process_config.json');
        fs.writeFileSync(configPath, JSON.stringify(config));

        const manager = ProcessManager.fromConfig(configPath);

        expect(manager).toBeInstanceOf(ProcessManager);
        expect(manager.maxPoolSize).toBe(10);
        expect(manager.processTimeout).toBe(5000);
    });
});
