import test from 'node:test';
import assert from 'node:assert/strict';
import { lane } from '../src/bootstrap.js';
test('control-plane package can execute TypeScript', () => assert.equal(lane, 'control-plane'));
