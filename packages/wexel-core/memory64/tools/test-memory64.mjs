import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const modulePath = process.argv[2] ?? 'build-memory64/wexel-core-memory64.wasm';
const GiB = 1024n ** 3n;
const { instance } = await WebAssembly.instantiate(await readFile(modulePath), {});
const api = instance.exports;
const memory = api.memory;

assert.equal(Number(api.wexel_memory64_pointer_bits()), 64);
assert.equal(api.wexel_memory64_limit_bytes(), 16n * GiB);
assert.equal(BigInt(memory.buffer.byteLength), 16n * 1024n * 1024n);
const original = api.wexel_memory64_alloc(32n);
assert.notEqual(original, 0n);
new Uint8Array(memory.buffer, Number(original), 4).set([87, 69, 88, 76]);
api.wexel_memory64_free(original);
assert.equal(api.wexel_memory64_alloc(16n), original, 'freed allocations should be reusable');
const reused = api.wexel_memory64_alloc(16n);
api.wexel_memory64_free(reused);
assert.equal(api.wexel_memory64_grow(16n * GiB), 1, 'Memory64 should grow to 16 GiB');
assert.equal(BigInt(memory.buffer.byteLength), 16n * GiB);
assert.equal(api.wexel_memory64_size_bytes(), 16n * GiB);
console.log('PASS: Core exports 64-bit pointers and a 16 GiB configured limit');
console.log('PASS: allocator can allocate, free, and reuse linear-memory blocks');
console.log('PASS: linear memory grows to 16 GiB');
console.log('NOTE: file and directory metadata are managed by the TypeScript VFS; this test does not write 16 GiB of payload data.');
