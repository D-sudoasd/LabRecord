import test from 'node:test';
import assert from 'node:assert/strict';
import { canCopyName, canCopyProtocol, protocolCopyText } from '../src/shared/copyText.js';

test('instrument names can be copied and file paths cannot', () => {
  assert.equal(canCopyName('SCAN-88421'), true);
  assert.equal(canCopyName('frame_088421.cbf'), true);
  assert.equal(canCopyName(''), false);
  assert.equal(canCopyName('a'.repeat(201)), false);
  assert.equal(canCopyName('D:\\beam\\SCAN-88421\\frame.cbf'), false);
  assert.equal(canCopyName('C:/data/frame.cbf'), false);
  assert.equal(canCopyName('line\nnext'), false);
  assert.equal(canCopyName('bad<name>'), false);
});

test('a heating protocol can be copied with slashes and a file path still cannot', () => {
  const protocol = '10 °C/min 升至 375 °C，保温 30 min。';
  assert.equal(canCopyProtocol(protocol), true);
  assert.equal(protocolCopyText(`  ${protocol}  `), protocol);
  assert.equal(canCopyProtocol('10 °C/min\n保温 30 min'), true);
  assert.equal(canCopyProtocol(''), false);
  assert.equal(canCopyProtocol('   '), false);
  assert.equal(canCopyProtocol('a'.repeat(4001)), false);
  assert.equal(canCopyProtocol('bad\u0000protocol'), false);
  assert.equal(canCopyName(protocol), false);
});
