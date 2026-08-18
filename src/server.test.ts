import {test, expect} from 'bun:test';
import {createServer} from './server';
import {TOOLS} from './tools/index';
import type {MistralClient} from './mistral-client';

function deps(complete: () => Promise<unknown>) {
  return {client: {complete} as unknown as MistralClient};
}

test('registers every tool in TOOLS', () => {
  const server = createServer(deps(async () => ({})));
  expect(server).toBeDefined();
  expect(TOOLS.map((tool) => tool.name).sort()).toEqual(['mistral_complete', 'mistral_extract']);
});

test('every tool has a non-empty title and description', () => {
  for (const tool of TOOLS) {
    expect(tool.config.title.length).toBeGreaterThan(0);
    expect(tool.config.description.length).toBeGreaterThan(0);
  }
});

test('every tool name is unique', () => {
  const names = TOOLS.map((tool) => tool.name);
  expect(new Set(names).size).toBe(names.length);
});

test('no tool claims to be read-only', () => {
  for (const tool of TOOLS) {
    expect(tool.config.annotations.readOnlyHint).toBe(false);
  }
});
