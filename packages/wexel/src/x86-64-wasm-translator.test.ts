import { describe, expect, it } from 'vitest';
import { translateX64ToWasm } from './x86-64-wasm-translator.js';

function instantiate(bytes:Uint8Array, syscall=(..._args:bigint[])=>0n) {
  const result=translateX64ToWasm(bytes);
  expect(result.diagnostics).toEqual([]);
  expect(WebAssembly.validate(result.wasm)).toBe(true);
  return WebAssembly.instantiate(result.wasm, {
    wexel_linux: { syscall },
  });
}

describe('x86-64 -> WASM binary translator',()=>{
  it('translates arithmetic and executes the generated WASM', async()=>{
    const code=new Uint8Array([
      0x48,0xb8,5,0,0,0,0,0,0,0,
      0x48,0xbb,7,0,0,0,0,0,0,0,
      0x48,0x01,0xd8,
      0xc3,
    ]);
    const instance=await instantiate(code);
    expect((instance.exports.run as ()=>bigint)()).toBe(12n);
  });

  it('translates absolute memory loads and stores', async()=>{
    const code=new Uint8Array([
      0x48,0xb8,0x34,0x12,0,0,0,0,0,0,
      0x48,0x89,0x04,0x25,0x00,0x02,0x00,0x00,
      0x48,0x8b,0x04,0x25,0x00,0x02,0x00,0x00,
      0xc3,
    ]);
    const instance=await instantiate(code);
    expect((instance.exports.run as ()=>bigint)()).toBe(0x1234n);
    const memory=instance.exports.memory as WebAssembly.Memory;
    expect(new DataView(memory.buffer).getBigUint64(0x200,true)).toBe(0x1234n);
  });

  it('translates conditional control flow', async()=>{
    const code=new Uint8Array([
      0x48,0xb8,1,0,0,0,0,0,0,0,
      0x48,0x39,0xc0,
      0x0f,0x84,0x0a,0x00,0x00,0x00,
      0x48,0xb8,2,0,0,0,0,0,0,0,
      0xc3,
      0x48,0xb8,3,0,0,0,0,0,0,0,
      0xc3,
    ]);
    const instance=await instantiate(code);
    expect((instance.exports.run as ()=>bigint)()).toBe(3n);
  });

  it('lowers Linux x86-64 syscall ABI to a WASM import', async()=>{
    const code=new Uint8Array([
      0x48,0xb8,39,0,0,0,0,0,0,0,
      0x0f,0x05,
      0xc3,
    ]);
    let syscallNumber=0n;
    const instance=await instantiate(code,(nr)=>{syscallNumber=nr;return 123n;});
    expect((instance.exports.run as ()=>bigint)()).toBe(123n);
    expect(syscallNumber).toBe(39n);
  });

  it('fails closed on an unsupported instruction',()=>{
    const result=translateX64ToWasm(new Uint8Array([0x0f,0x0b]));
    expect(result.wasm.byteLength).toBe(0);
    expect(result.diagnostics.length).toBe(1);
  });
});
