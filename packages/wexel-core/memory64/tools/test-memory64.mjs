import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const modulePath = process.argv[2] ?? 'build-memory64/wexel-core-memory64.wasm';
const GiB = 1024n ** 3n;
const { instance } = await WebAssembly.instantiate(await readFile(modulePath), {});
const api = instance.exports;
const memory = api.memory;
const enc = new TextEncoder();
const dec = new TextDecoder();

assert.equal(Number(api.wexel_memory64_pointer_bits()), 64);
assert.equal(api.wexel_memory64_limit_bytes(), 16n * GiB);
assert.equal(api.wexel_vfs_init(16n * GiB), 1);
assert.equal(api.wexel_vfs_quota_bytes(), 16n * GiB);
assert.equal(api.wexel_vfs_init(16n * GiB + 1n), 0);

function putBytes(bytes) {
  const ptr = api.wexel_memory64_alloc(BigInt(bytes.length));
  assert.notEqual(ptr, 0n, 'linear-memory allocation failed');
  new Uint8Array(memory.buffer, Number(ptr), bytes.length).set(bytes);
  return ptr;
}
function pathPointer(path) {
  const bytes = enc.encode(path);
  return { ptr: putBytes(bytes), len: bytes.length };
}
function readListing(path) {
  const p = pathPointer(path);
  const out = api.wexel_memory64_alloc(4096n);
  const len = api.wexel_vfs_list(p.ptr, p.len, out, 4096n);
  assert.ok(len >= 0n, `listing failed for ${path}: ${len}`);
  return dec.decode(new Uint8Array(memory.buffer, Number(out), Number(len))).split('\0').filter(Boolean);
}

const root = pathPointer('/');
assert.equal(api.wexel_vfs_is_directory(root.ptr, root.len), 1);
const home = pathPointer('/home');
assert.equal(api.wexel_vfs_mkdir(home.ptr, home.len), 1);
const user = pathPointer('/home/user');
assert.equal(api.wexel_vfs_mkdir(user.ptr, user.len), 1);
const filePath = pathPointer('/home/user/demo.py');
const content = enc.encode("print('hello from Wexel Core')");
const contentPtr = putBytes(content);
assert.equal(api.wexel_vfs_write(filePath.ptr, filePath.len, contentPtr, BigInt(content.length)), 1);
assert.equal(api.wexel_vfs_file_count(), 1);
assert.equal(api.wexel_vfs_directory_count(), 3);
assert.deepEqual(readListing('/'), ['home']);
assert.deepEqual(readListing('/home'), ['user']);
assert.deepEqual(readListing('/home/user'), ['demo.py']);
const missingChild = pathPointer('/missing/child');
assert.equal(api.wexel_vfs_mkdir(missingChild.ptr, missingChild.len), 0);
assert.equal(api.wexel_vfs_rmdir(user.ptr, user.len), 0, 'non-empty directory must not be removed');

const outPtr = api.wexel_memory64_alloc(4096n);
const readLen = api.wexel_vfs_read(filePath.ptr, filePath.len, outPtr, 4096n);
assert.equal(readLen, BigInt(content.length));
assert.equal(dec.decode(new Uint8Array(memory.buffer, Number(outPtr), Number(readLen))), dec.decode(content));

const maxBytes = 16n * GiB;
assert.equal(api.wexel_memory64_grow(maxBytes), 1, 'Memory64 manager must grow memory to its configured maximum');
assert.equal(BigInt(memory.buffer.byteLength), maxBytes);
assert.equal(api.wexel_memory64_size_bytes(), maxBytes);
assert.equal(api.wexel_memory_bytes(), maxBytes);
const readLenAfterGrow = api.wexel_vfs_read(filePath.ptr, filePath.len, outPtr, 4096n);
assert.equal(readLenAfterGrow, BigInt(content.length));
assert.equal(dec.decode(new Uint8Array(memory.buffer, Number(outPtr), Number(readLenAfterGrow))), dec.decode(content));

assert.equal(api.wexel_vfs_remove(filePath.ptr, filePath.len), 1);
assert.equal(api.wexel_vfs_rmdir(user.ptr, user.len), 1);
assert.equal(api.wexel_vfs_rmdir(home.ptr, home.len), 1);
assert.equal(api.wexel_vfs_directory_count(), 1);

console.log('PASS: Memory64 ABI uses 64-bit pointers');
console.log('PASS: separate Memory64 manager owns allocation and linear-memory growth');
console.log('PASS: Linux-like mkdir, parent checks, list, file read/write, and empty-only rmdir');
console.log('PASS: existing VFS data survives growth to 16 GiB');
console.log('LIMIT: 16 GiB of file contents were not written; this verifies maximum linear-memory growth and small-file integrity.');
