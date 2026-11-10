import test from 'node:test';
import assert from 'node:assert/strict';
import { orderIndexOf, remainingCount, shuffleIndices, stepPosition } from './queue.ts';

test('очередь: следующий/предыдущий внутри списка', () => {
  assert.equal(stepPosition(0, 3, 'off', 1), 1);
  assert.equal(stepPosition(1, 3, 'off', -1), 0);
});

test('очередь: конец списка без повтора останавливает воспроизведение', () => {
  assert.equal(stepPosition(2, 3, 'off', 1), null);
  assert.equal(stepPosition(0, 3, 'off', -1), null);
});

test('очередь: повтор «все» и ручные кнопки заворачивают край', () => {
  assert.equal(stepPosition(2, 3, 'all', 1), 0);
  assert.equal(stepPosition(0, 3, 'all', -1), 2);
  assert.equal(stepPosition(2, 3, 'off', 1, true), 0, 'кнопка «дальше» заворачивает всегда');
  assert.equal(stepPosition(0, 3, 'off', -1, true), 2);
});

test('очередь: пустой список и единственный трек', () => {
  assert.equal(stepPosition(0, 0, 'all', 1), null);
  assert.equal(stepPosition(0, 1, 'all', 1), 0);
  assert.equal(stepPosition(0, 1, 'off', 1), null);
});

test('очередь: перемешивание — перестановка с текущим треком впереди', () => {
  const random = () => 0.5;
  const order = shuffleIndices(5, 2, random);
  assert.equal(order.length, 5);
  assert.equal(order[0], 2);
  assert.deepEqual([...order].sort(), [0, 1, 2, 3, 4]);
  assert.equal(orderIndexOf(order, 2), 0);
  assert.equal(remainingCount(0, 5), 4);
  assert.deepEqual(shuffleIndices(0, 0), []);
});
