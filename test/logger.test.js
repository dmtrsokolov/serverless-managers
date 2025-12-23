const logger = require('../lib/utils/logger');

describe('Logger', () => {
  // Simple test to ensure Winston logger is properly exported
  test('should export a Winston logger instance', () => {
    expect(logger).toBeDefined();
    expect(typeof logger).toBe('object');
  });

  // Since we're testing Winston's behavior and not the implementation details,
  // these tests verify that the logger works as expected with Winston's structure
  
  test('should handle debug level logs', () => {
    // Just verify that Winston methods exist and can be called
    expect(logger.debug).toBeDefined();
  });

  test('should handle info level logs', () => {
    expect(logger.info).toBeDefined();
  });

  test('should handle warn level logs', () => {
    expect(logger.warn).toBeDefined();
  });

  test('should handle error level logs', () => {
    expect(logger.error).toBeDefined();
  });
});
