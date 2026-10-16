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

// Regression: caps must be page-aligned so rounded growth cannot exceed them.
const pageBytes = 65536n;
const beforePageTest = api.wexel_memory64_size_bytes();
assert.equal(api.wexel_memory64_set_limit(beforePageTest + pageBytes), 1);
assert.equal(api.wexel_memory64_set_limit(beforePageTest + 1n), 0);
assert.equal(api.wexel_memory64_limit_bytes(), beforePageTest + pageBytes);
assert.equal(api.wexel_memory64_grow(beforePageTest + 1n), 1);
assert.equal(api.wexel_memory64_size_bytes(), beforePageTest + pageBytes);
assert.equal(api.wexel_memory64_set_limit(16n * GiB), 1);

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
  const needed = api.wexel_vfs_list_size(p.ptr, p.len);
  assert.ok(needed >= 0n, `list-size failed for ${path}: ${needed}`);
  const out = needed === 0n ? 0n : api.wexel_memory64_alloc(needed);
  const len = api.wexel_vfs_list(p.ptr, p.len, out, needed);
  assert.ok(len >= 0n, `listing failed for ${path}: ${len}`);
  const values = len === 0n ? [] : dec.decode(new Uint8Array(memory.buffer, Number(out), Number(len))).split('\0').filter(Boolean);
  api.wexel_memory64_free(p.ptr);
  if (out) api.wexel_memory64_free(out);
  return values;
}

const reusable = api.wexel_memory64_alloc(32n);
assert.notEqual(reusable, 0n);
api.wexel_memory64_free(reusable);
assert.equal(api.wexel_memory64_alloc(16n), reusable, 'freed linear-memory blocks should be reused');
api.wexel_memory64_free(reusable);

// Regression: an aligned pointer into a payload must not be accepted by free().
const guarded = api.wexel_memory64_alloc(64n);
assert.notEqual(guarded, 0n);
new BigUint64Array(memory.buffer, Number(guarded), 2).set([16n, 0n]);
api.wexel_memory64_free(guarded + 16n);
api.wexel_memory64_free(guarded);
const wholeBlock = api.wexel_memory64_alloc(64n);
assert.equal(wholeBlock, guarded, 'invalid interior free must not corrupt the free list');
const followupBlock = api.wexel_memory64_alloc(16n);
assert.notEqual(followupBlock, guarded + 16n, 'allocator must not return an interior region overlapping an active allocation');
const secondFollowupBlock = api.wexel_memory64_alloc(16n);
assert.notEqual(secondFollowupBlock, guarded + 16n, 'a forged free-list node must not be reused');
api.wexel_memory64_free(wholeBlock);
api.wexel_memory64_free(followupBlock);
api.wexel_memory64_free(secondFollowupBlock);

const root = pathPointer('/');
assert.equal(api.wexel_vfs_is_directory(root.ptr, root.len), 1);
api.wexel_memory64_free(root.ptr);
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
api.wexel_memory64_free(missingChild.ptr);
assert.equal(api.wexel_vfs_rmdir(user.ptr, user.len), 0, 'non-empty directory must not be removed');

const outPtr = api.wexel_memory64_alloc(4096n);
const readLen = api.wexel_vfs_read(filePath.ptr, filePath.len, outPtr, 4096n);
assert.equal(readLen, BigInt(content.length));
assert.equal(dec.decode(new Uint8Array(memory.buffer, Number(outPtr), Number(readLen))), dec.decode(content));

const replacement = enc.encode('replacement');
const replacementPath = pathPointer('/home/user/demo.py');
const replacementPtr = putBytes(replacement);
assert.equal(api.wexel_vfs_write(replacementPath.ptr, replacementPath.len, replacementPtr, BigInt(replacement.length)), 1);
assert.equal(api.wexel_vfs_file_size(filePath.ptr, filePath.len), BigInt(replacement.length));
assert.equal(api.wexel_vfs_bytes_used(), BigInt(replacement.length));

const many = pathPointer('/many');
assert.equal(api.wexel_vfs_mkdir(many.ptr, many.len), 1);
for (let i = 0; i < 700; i++) {
  const child = pathPointer(`/many/d${i}`);
  assert.equal(api.wexel_vfs_mkdir(child.ptr, child.len), 1, `mkdir failed at entry ${i}`);
}
assert.equal(api.wexel_vfs_directory_count(), 704);
assert.equal(api.wexel_vfs_remove_tree(many.ptr, many.len), 1);
assert.equal(api.wexel_vfs_directory_count(), 3);

const maxBytes = 16n * GiB;
assert.equal(api.wexel_memory64_grow(maxBytes), 1, 'Memory64 manager must grow memory to its configured maximum');
assert.equal(BigInt(memory.buffer.byteLength), maxBytes);
assert.equal(api.wexel_memory64_size_bytes(), maxBytes);
assert.equal(api.wexel_memory_bytes(), maxBytes);
const readLenAfterGrow = api.wexel_vfs_read(filePath.ptr, filePath.len, outPtr, 4096n);
assert.equal(readLenAfterGrow, BigInt(replacement.length));
assert.equal(dec.decode(new Uint8Array(memory.buffer, Number(outPtr), Number(readLenAfterGrow))), dec.decode(replacement));
api.wexel_memory64_free(outPtr);

assert.equal(api.wexel_vfs_remove_tree(user.ptr, user.len), 1);
assert.equal(api.wexel_vfs_directory_count(), 2);
assert.equal(api.wexel_vfs_rmdir(home.ptr, home.len), 1);
assert.equal(api.wexel_vfs_directory_count(), 1);

console.log('PASS: Memory64 ABI uses 64-bit pointers');
console.log('PASS: separate Memory64 manager owns allocation and linear-memory growth');
console.log('PASS: Linux-like mkdir, parent checks, list, file read/write, and empty-only rmdir');
console.log('PASS: existing VFS data survives growth to 16 GiB');
console.log('LIMIT: 16 GiB of file contents were not written; this verifies maximum linear-memory growth and small-file integrity.');
