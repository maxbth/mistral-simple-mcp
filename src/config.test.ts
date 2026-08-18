import {test, expect} from 'bun:test';
import {loadConfig, ConfigError} from './config';

const base = {MISTRAL_API_KEY: 'sk-test-key'};

test('loads a minimal valid config with defaults', () => {
  const config = loadConfig(base, []);
  expect(config.mistral.apiKey).toBe('sk-test-key');
  expect(config.mistral.model).toBe('mistral-medium-latest');
  expect(config.mistral.timeoutMs).toBe(60_000);
  expect(config.mistral.baseUrl).toBeUndefined();
  expect(config.mcp.transport).toBe('http');
  expect(config.mcp.host).toBe('127.0.0.1');
  expect(config.mcp.port).toBe(3_000);
  expect(config.mcp.path).toBe('/mcp');
  expect(config.mcp.allowedOrigins).toEqual([]);
});

test('accepts a custom MCP_HTTP_PATH', () => {
  expect(
    loadConfig(
      {
        ...base,
        MCP_HTTP_PATH: '/custom/path',
      },
      [],
    ).mcp.path,
  ).toBe('/custom/path');
});

test('rejects an MCP_HTTP_PATH without a leading slash', () => {
  expect(() =>
    loadConfig(
      {
        ...base,
        MCP_HTTP_PATH: 'mcp',
      },
      [],
    ),
  ).toThrow(ConfigError);
});

test('rejects a missing api key', () => {
  expect(() => loadConfig({}, [])).toThrow(ConfigError);
});

test('treats an empty api key as missing', () => {
  expect(() => loadConfig({MISTRAL_API_KEY: ''}, [])).toThrow(ConfigError);
});

test('never puts the api key in the error message', () => {
  try {
    loadConfig(
      {
        MISTRAL_API_KEY: 'sk-secret-value',
        MCP_PORT: '0',
      },
      [],
    );
    throw new Error('expected loadConfig to throw');
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).not.toContain('sk-secret-value');
  }
});

test('accepts each supported model as the default', () => {
  expect(
    loadConfig(
      {
        ...base,
        MISTRAL_DEFAULT_MODEL: 'mistral-small-latest',
      },
      [],
    ).mistral.model,
  ).toBe('mistral-small-latest');
  expect(
    loadConfig(
      {
        ...base,
        MISTRAL_DEFAULT_MODEL: 'mistral-large-latest',
      },
      [],
    ).mistral.model,
  ).toBe('mistral-large-latest');
});

test('rejects a model outside the enum', () => {
  expect(() =>
    loadConfig(
      {
        ...base,
        MISTRAL_DEFAULT_MODEL: 'mistral-tiny',
      },
      [],
    ),
  ).toThrow(ConfigError);
});

test('--stdio argv overrides the configured transport', () => {
  expect(
    loadConfig(
      {
        ...base,
        MCP_TRANSPORT: 'http',
      },
      ['--stdio'],
    ).mcp.transport,
  ).toBe('stdio');
});

test('splits and trims the allowed origin list, dropping empties', () => {
  const config = loadConfig(
    {
      ...base,
      MCP_ALLOWED_ORIGINS: 'https://a.example.com, https://b.example.com, ',
    },
    [],
  );
  expect(config.mcp.allowedOrigins).toEqual(['https://a.example.com', 'https://b.example.com']);
});

test('rejects a non-numeric timeout and an out-of-range port', () => {
  expect(() =>
    loadConfig(
      {
        ...base,
        MISTRAL_TIMEOUT_MS: 'soon',
      },
      [],
    ),
  ).toThrow(ConfigError);
  expect(() =>
    loadConfig(
      {
        ...base,
        MCP_PORT: '70000',
      },
      [],
    ),
  ).toThrow(ConfigError);
});

test('rejects a base url that is not a url', () => {
  expect(() =>
    loadConfig(
      {
        ...base,
        MISTRAL_BASE_URL: 'not-a-url',
      },
      [],
    ),
  ).toThrow(ConfigError);
});
