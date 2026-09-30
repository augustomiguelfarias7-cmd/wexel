/**
 * x86-64 -> WebAssembly binary translator.
 *
 * This is a translation backend, not an x86 CPU emulator:
 * x86 instructions are decoded once, lowered to WASM instructions, and
 * WebAssembly executes the generated code. The small block-dispatch loop only
 * selects already-generated basic blocks; it never interprets x86 opcodes.
 */
export const X64_WASM_TRANSLATOR_ABI = 3;

export type X64Register =
  | 'rax'|'rcx'|'rdx'|'rbx'|'rsp'|'rbp'|'rsi'|'rdi'
  | 'r8'|'r9'|'r10'|'r11'|'r12'|'r13'|'r14'|'r15';

const REGISTERS: X64Register[] = [
  'rax','rcx','rdx','rbx','rsp','rbp','rsi','rdi',
  'r8','r9','r10','r11','r12','r13','r14','r15',
];

export type X64Mnemonic =
  | 'nop'|'ret'|'mov_imm'|'mov_rr'|'xor_rr'|'add_rr'|'sub_rr'
  | 'cmp_rr'|'test_rr'|'syscall'|'lea'|'load64'|'store64'
  | 'push'|'pop'|'call_rel'|'jmp_rel'
  | 'jz_rel'|'jnz_rel'|'jl_rel'|'jle_rel'|'jg_rel'|'jge_rel';

export interface X64Instruction {
  offset:number;
  size:number;
  mnemonic:X64Mnemonic;
  dst?:number;
  src?:number;
  base?:number;
  index?:number;
  scale?:number;
  disp?:number;
  imm?:bigint;
  target?:number;
}

export interface X64TranslationDiagnostic {
  offset:number;
  message:string;
}

export interface X64TranslationResult {
  wasm:Uint8Array;
  instructions:X64Instruction[];
  diagnostics:X64TranslationDiagnostic[];
}

export interface X64WasmTranslatorOptions {
  syscallModule?:string;
  syscallName?:string;
  memoryPages?:number;
  codeOffset?:number;
  stackTop?:number;
}

interface Block { id:number; start:number; end:number; instructions:X64Instruction[]; }
interface Address {
  end:number;
  base?:number;
  index?:number;
  scale:number;
  disp:number;
  ripRelative:boolean;
}

const REG_COUNT = 16;
const ZF = 16, SF = 17, CF = 18, OF = 19, PC = 20, DEPTH = 21, TMP = 22;
const I64 = 0x7e;
const I32 = 0x7f;

export function x64RegisterIndex(register:X64Register):number {
  return REGISTERS.indexOf(register);
}
export function x64RegisterName(index:number):X64Register {
  if (!REGISTERS[index]) throw new Error('invalid x86-64 register index '+index);
  return REGISTERS[index];
}

export function translateX64ToWasm(
  code:Uint8Array,
  options:X64WasmTranslatorOptions = {},
):X64TranslationResult {
  const instructions:X64Instruction[] = [];
  const diagnostics:X64TranslationDiagnostic[] = [];
  let offset = 0;

  while (offset < code.length) {
    try {
      const d = decode(code, offset);
      instructions.push(d);
      offset += d.size;
    } catch (error) {
      diagnostics.push({
        offset,
        message:error instanceof Error ? error.message : String(error),
      });
      break;
    }
  }

  if (diagnostics.length) return { wasm:new Uint8Array(), instructions, diagnostics };

  try {
    const wasm = emitWasm(instructions, code, options);
    if (!WebAssembly.validate(wasm)) {
      diagnostics.push({offset:code.length, message:'generated WebAssembly failed validation'});
      return {wasm:new Uint8Array(), instructions, diagnostics};
    }
    return {wasm, instructions, diagnostics};
  } catch (error) {
    diagnostics.push({
      offset:code.length,
      message:error instanceof Error ? error.message : String(error),
    });
    return {wasm:new Uint8Array(), instructions, diagnostics};
  }
}

function decode(code:Uint8Array, start:number):X64Instruction {
  let p = start;
  let rex = 0;
  let op = readU8(code, p++);

  if ((op & 0xf0) === 0x40) {
    rex = op;
    op = readU8(code, p++);
  }

  const w = (rex & 8) !== 0;
  const r = (rex & 4) !== 0;
  const b = (rex & 1) !== 0;

  if (op === 0x90) return {offset:start,size:p-start,mnemonic:'nop'};
  if (op === 0xc3) return {offset:start,size:p-start,mnemonic:'ret'};

  if (op === 0x0f) {
    const op2 = readU8(code, p++);
    const rel = readI32(code, p);
    const conditional:Record<number,X64Mnemonic|undefined> = {
      0x84:'jz_rel', 0x85:'jnz_rel', 0x8c:'jl_rel', 0x8e:'jle_rel',
      0x8f:'jg_rel', 0x8d:'jge_rel',
    };
    const mnemonic = conditional[op2];
    if (mnemonic) {
      if (p + 4 > code.length) throw new Error('truncated conditional branch');
      return {offset:start,size:p+4-start,mnemonic,target:p+4+rel};
    }
    if (op2 === 0x05) return {offset:start,size:p-start,mnemonic:'syscall'};
    throw new Error('unsupported 0x0f opcode 0x'+op2.toString(16));
  }

  if (op >= 0xb8 && op <= 0xbf) {
    const dst = (op - 0xb8) | (b ? 8 : 0);
    if (w) {
      return {offset:start,size:p+8-start,mnemonic:'mov_imm',dst,imm:readI64(code,p)};
    }
    return {
      offset:start,size:p+4-start,mnemonic:'mov_imm',dst,
      imm:BigInt(readU32(code,p)),
    };
  }

  if (op === 0xe8) {
    const rel = readI32(code,p);
    return {offset:start,size:p+4-start,mnemonic:'call_rel',target:p+4+rel};
  }
  if (op === 0xe9) {
    const rel = readI32(code,p);
    return {offset:start,size:p+4-start,mnemonic:'jmp_rel',target:p+4+rel};
  }
  if (op === 0xeb) {
    const rel = readI8(code,p);
    return {offset:start,size:p+1-start,mnemonic:'jmp_rel',target:p+1+rel};
  }

  if (op === 0x50 || op === 0x58) {
    const reg = (op & 7) | (b ? 8 : 0);
    return {offset:start,size:p-start,mnemonic:op === 0x50 ? 'push' : 'pop',src:reg,dst:reg};
  }

  const modrm = readU8(code,p++);
  const mod = modrm >>> 6;
  const reg = ((modrm >>> 3) & 7) | (r ? 8 : 0);
  const rm = (modrm & 7) | (b ? 8 : 0);

  if (mod === 3) {
    const map:Record<number,X64Mnemonic|undefined> = {
      0x89:'mov_rr',0x8b:'mov_rr',
      0x31:'xor_rr',0x33:'xor_rr',
      0x01:'add_rr',0x03:'add_rr',
      0x29:'sub_rr',0x2b:'sub_rr',
      0x39:'cmp_rr',0x3b:'cmp_rr',
      0x85:'test_rr',
    };
    const mnemonic = map[op];
    if (!mnemonic) throw new Error('unsupported register opcode 0x'+op.toString(16));
    const reversed = [0x8b,0x33,0x03,0x2b,0x3b].includes(op);
    return {
      offset:start,size:p-start,mnemonic,
      dst:reversed ? reg : rm, src:reversed ? rm : reg,
    };
  }

  if (op === 0x8d || op === 0x8b || op === 0x89 || op === 0x03 || op === 0x01) {
    const a = decodeAddress(code,start,p,modrm,reg,rm);
    if (op === 0x8d) {
      return {
        offset:start,size:a.end-start,mnemonic:'lea',dst:reg,
        base:a.base,index:a.index,scale:a.scale,disp:a.disp,
      };
    }
    if (a.ripRelative && op !== 0x8b && op !== 0x89) {
      throw new Error('RIP-relative arithmetic memory operand is not yet lowered');
    }
    return {
      offset:start,size:a.end-start,
      mnemonic:op === 0x8b || op === 0x03 ? 'load64' : 'store64',
      dst:reg,src:reg,base:a.base,index:a.index,scale:a.scale,disp:a.disp,
    };
  }

  throw new Error('unsupported x86-64 opcode 0x'+op.toString(16));
}

function decodeAddress(
  code:Uint8Array,
  start:number,
  p0:number,
  modrm:number,
  _reg:number,
  rm:number,
):Address {
  let p = p0;
  const mod = modrm >>> 6;
  let base:number|undefined;
  let index:number|undefined;
  let scale = 1;
  let disp = 0;
  let ripRelative = false;

  if ((rm & 7) === 4) {
    const sib = readU8(code,p++);
    scale = 1 << ((sib >>> 6) & 3);
    const i = (sib >>> 3) & 7;
    const rawBase = sib & 7;
    if (i !== 4) index = i | (rm & 8);
    if (rawBase === 5 && mod === 0) {
      if ((rm & 8) === 0) ripRelative = true;
      else base = 13;
    } else {
      base = rawBase | (rm & 8);
    }
  } else if (mod === 0 && (rm & 7) === 5) {
    ripRelative = true;
  } else {
    base = rm;
  }

  if (mod === 1) {
    disp = readI8(code,p++);
  } else if (mod === 2) {
    disp = readI32(code,p);
    p += 4;
  } else if (mod === 0 && ripRelative) {
    disp = readI32(code,p);
    p += 4;
  }

  if (ripRelative && index !== undefined) {
    throw new Error('invalid RIP-relative SIB form');
  }

  return {end:p,base,index,scale,disp,ripRelative};
}

function emitWasm(
  instructions:X64Instruction[],
  code:Uint8Array,
  options:X64WasmTranslatorOptions,
):Uint8Array {
  const blocks = makeBlocks(instructions);
  const blockByOffset = new Map<number,number>();
  for (const block of blocks) blockByOffset.set(block.start,block.id);

  for (const ins of instructions) {
    if (ins.target !== undefined && !blockByOffset.has(ins.target)) {
      throw new Error('branch target 0x'+ins.target.toString(16)+' is outside translated code');
    }
  }

  const memoryPages = Math.max(1, Math.min(65536, options.memoryPages ?? 256));
  const codeOffset = options.codeOffset ?? 65536;
  const stackTop = options.stackTop ?? memoryPages * 65536 - 16;

  if (codeOffset + code.length > memoryPages * 65536) {
    throw new Error('code does not fit in configured WASM memory');
  }

  const types = [
    funcType([], [I64]),
    funcType(new Array(7).fill(I64), [I64]),
  ];

  const imports = concat([
    name(options.syscallModule ?? 'wexel_linux'),
    name(options.syscallName ?? 'syscall'),
    new Uint8Array([0,1]),
  ]);

  const functionSection = vec([new Uint8Array([0])]);
  const memorySection = vec([concat([new Uint8Array([0]),u32(memoryPages)])]);
  const exportSection = vec([
    concat([name('run'),new Uint8Array([0,1])]),
    concat([name('memory'),new Uint8Array([2,0])]),
  ]);

  const body = emitRun(blocks,blockByOffset,codeOffset,stackTop);
  const data = activeData(codeOffset,code);

  return concat([
    wasmHeader(),
    section(1,vec(types)),
    section(2,vec([imports])),
    section(3,functionSection),
    section(5,memorySection),
    section(7,exportSection),
    section(10,vec([concat([u32(1),u32(body.length),body])])),
    section(11,vec([data])),
  ]);
}

function makeBlocks(instructions:X64Instruction[]):Block[] {
  const leaders = new Set<number>([instructions[0]?.offset ?? 0]);
  for (const ins of instructions) {
    if (ins.target !== undefined) leaders.add(ins.target);
    if (
      ins.mnemonic === 'jmp_rel' ||
      ins.mnemonic === 'jz_rel' || ins.mnemonic === 'jnz_rel' ||
      ins.mnemonic === 'jl_rel' || ins.mnemonic === 'jle_rel' ||
      ins.mnemonic === 'jg_rel' || ins.mnemonic === 'jge_rel' ||
      ins.mnemonic === 'ret' || ins.mnemonic === 'call_rel'
    ) {
      const next = ins.offset + ins.size;
      if (next < (instructions.at(-1)?.offset ?? 0) + (instructions.at(-1)?.size ?? 0)) leaders.add(next);
    }
  }

  const sorted = [...leaders].filter(x => instructions.some(i => i.offset === x)).sort((a,b)=>a-b);
  return sorted.map((start,id) => {
    const first = instructions.findIndex(i => i.offset === start);
    const next = sorted[id+1];
    const body = instructions.slice(first, next === undefined ? instructions.length : instructions.findIndex(i=>i.offset===next));
    return {id,start,end:next ?? Infinity,instructions:body};
  });
}

function emitRun(
  blocks:Block[],
  blockByOffset:Map<number,number>,
  codeOffset:number,
  stackTop:number,
):Uint8Array {
  const locals = concat([
    u32(3),
    u32(16),new Uint8Array([I64]),
    u32(6),new Uint8Array([I32]),
    u32(1),new Uint8Array([I64]),
  ]);

  const body:number[] = [...locals];

  // RSP starts at the top of the WASM linear memory.
  emit(body,0x42,...signedLeb(stackTop)); // i64.const
  emit(body,0x21,...u32(RSP)); // local.set rsp
  emit(body,0x41,0,0x21,...u32(PC)); // pc = entry block
  emit(body,0x41,0,0x21,...u32(DEPTH)); // call depth = 0

  // One translated-block selector. It never decodes or interprets x86 at runtime.
  emit(body,0x02,0x40); // block exit
  emit(body,0x03,0x40); // loop

  for (const block of blocks) {
    emit(body,0x20,...u32(PC));
    emit(body,0x41,...u32(block.id));
    body.push(0x46,0x04,0x40); // if

    for (const ins of block.instructions) {
      emitInstruction(body,ins,block,blockByOffset,codeOffset);
    }

    // If a block did not terminate, continue with the lexical successor.
    const last = block.instructions.at(-1);
    if (!last || !isTerminator(last)) {
      const next = blocks[block.id+1];
      if (!next) {
        body.push(0x0b); // end if
        emit(body,0x0f); // return
        continue;
      }
      setPc(body,next.id);
      body.push(0x0b);
      emit(body,0x0c,0); // br loop
    } else {
      body.push(0x0b);
    }
  }

  // End loop and outer block, then return rax.
  body.push(0x0b,0x0b);
  emit(body,0x20,...u32(0));
  body.push(0x0f,0x0b);

  return new Uint8Array(body);
}

function emitInstruction(
  out:number[],
  ins:X64Instruction,
  block:Block,
  blockByOffset:Map<number,number>,
  codeOffset:number,
  fallthrough:number|undefined,
):void {
  const dst = ins.dst ?? 0;
  const src = ins.src ?? 0;

  switch (ins.mnemonic) {
    case 'nop': return;
    case 'mov_imm':
      emit(out,0x42,...signedLeb(ins.imm ?? 0n),0x21,...u32(dst));
      return;
    case 'mov_rr':
      emit(out,0x20,...u32(src),0x21,...u32(dst));
      return;
    case 'xor_rr':
      emit(out,0x20,...u32(dst),0x20,...u32(src),0x85,0x21,...u32(dst));
      setLogicFlags(out,dst);
      return;
    case 'add_rr':
      emitBinaryArithmetic(out,dst,src,0x7c);
      setAddFlags(out,dst,src);
      return;
    case 'sub_rr':
      emitBinaryArithmetic(out,dst,src,0x7d);
      setSubFlags(out,dst,src);
      return;
    case 'cmp_rr':
      emit(out,0x20,...u32(dst),0x20,...u32(src),0x7d);
      emit(out,0x21,...u32(TMP));
      setSubFlagsFromTemp(out,dst,src);
      return;
    case 'test_rr':
      emit(out,0x20,...u32(dst),0x20,...u32(src),0x83);
      emit(out,0x21,...u32(TMP));
      setLogicFlags(out,TMP);
      clearFlag(out,CF); clearFlag(out,OF);
      return;
    case 'lea':
      emitAddress(out,ins,codeOffset);
      emit(out,0x21,...u32(dst));
      return;
    case 'load64':
      emitAddress(out,ins,codeOffset);
      out.push(0xa9); // i64.load, align=1, offset=0
      out.push(0x00);
      emit(out,0x21,...u32(dst));
      return;
    case 'store64':
      emitAddress(out,ins,codeOffset);
      emit(out,0x20,...u32(src));
      out.push(0x37,0x00); // i64.store, align=1, offset=0
      return;
    case 'push':
      emitPush(out,src);
      return;
    case 'pop':
      emitPop(out,dst);
      return;
    case 'syscall':
      emitSyscall(out);
      return;
    case 'jmp_rel':
      branchTo(out,blockByOffset,ins.target!);
      return;
    case 'jz_rel':
      conditionalBranch(out,blockByOffset,ins.target!,ZF,0x45,fallthrough);
      return;
    case 'jnz_rel':
      conditionalBranch(out,blockByOffset,ins.target!,ZF,0x50,fallthrough);
      return;
    case 'jl_rel':
      emitSignedLess(out,blockByOffset,ins.target!,SF,OF,fallthrough);
      return;
    case 'jge_rel':
      emitSignedGreaterEqual(out,blockByOffset,ins.target!,SF,OF,fallthrough);
      return;
    case 'jle_rel':
      emitSignedLessEqual(out,blockByOffset,ins.target!,SF,OF);
      return;
    case 'jg_rel':
      emitSignedGreater(out,blockByOffset,ins.target!,ZF,SF,OF,fallthrough);
      return;
    case 'call_rel': {
      const target = blockByOffset.get(ins.target!);
      if (target === undefined) throw new Error('call target is not a translated block');
      const returnOffset = block.end;
      const returnBlock = blockByOffset.get(returnOffset);
      if (returnBlock === undefined) throw new Error('call has no translated return block');
      // Translation call stack lives above the x86 stack frame and stores block IDs.
      emit(out,0x41,...u32(0x1000));
      emit(out,0x20,...u32(DEPTH),0x41,3,0x74,0x6a);
      emit(out,0x42,...signedLeb(BigInt(returnBlock)),0x37,0x00);
      emit(out,0x20,...u32(DEPTH),0x41,1,0x7c,0x21,...u32(DEPTH));
      setPc(out,target);
      out.push(0x0c,0);
      return;
    }
    case 'ret':
      emit(out,0x20,...u32(DEPTH));
      emit(out,0x45,0x04,0x40); // if depth == 0
      out.push(0x0f); // return
      out.push(0x0b);
      emit(out,0x20,...u32(DEPTH),0x42,1,0x7d,0x21,...u32(DEPTH));
      // Translation return stack is held in linear memory at a fixed high slot.
      // Use DEPTH*8 as the slot.
      emit(out,0x41,...u32(0x1000));
      emit(out,0x20,...u32(DEPTH),0x41,3,0x74,0x6a);
      out.push(0x29,0x00,0x00);
      emit(out,0x21,...u32(PC));
      out.push(0x0c,0);
      return;
  }
}

const RSP = 4;

function emitPush(out:number[],reg:number):void {
  emit(out,0x20,...u32(RSP),0x42,8,0x7d,0x21,...u32(RSP));
  emit(out,0x20,...u32(RSP),0x20,...u32(reg),0x37,0x00);
}
function emitPop(out:number[],reg:number):void {
  emit(out,0x20,...u32(RSP),0x29,0x00,0x00,0x21,...u32(reg));
  emit(out,0x20,...u32(RSP),0x42,8,0x7c,0x21,...u32(RSP));
}

function emitAddress(out:number[],ins:X64Instruction,codeOffset:number):void {
  if (ins.base !== undefined) emit(out,0x20,...u32(ins.base));
  else emit(out,0x42,...signedLeb(BigInt(ins.disp ?? 0)));
  if (ins.index !== undefined) {
    emit(out,0x20,...u32(ins.index));
    if ((ins.scale ?? 1) !== 1) {
      emit(out,0x42,...signedLeb(BigInt(Math.log2(ins.scale ?? 1))),0x86);
    }
    out.push(0x7c);
  }
  if (ins.base === undefined && ins.index === undefined) {
    if ((ins.disp ?? 0) !== 0) emit(out,0x42,...signedLeb(BigInt(ins.disp!)),0x7c);
  } else if ((ins.disp ?? 0) !== 0) {
    emit(out,0x42,...signedLeb(BigInt(ins.disp!)),0x7c);
  }
  // WASM memory addresses are i32. The generated code intentionally truncates
  // the translated x86 virtual address at the WASM memory boundary.
  out.push(0xa7);
  void codeOffset;
}

function emitBinaryArithmetic(out:number[],dst:number,src:number,opcode:number):void {
  emit(out,0x20,...u32(dst),0x20,...u32(src),opcode,0x21,...u32(dst));
}

function setLogicFlags(out:number,reg:number):void {
  emit(out,0x20,...u32(reg),0x50,0x21,...u32(ZF));
  emit(out,0x20,...u32(reg),0x42,0,0x53,0x21,...u32(SF));
}

function setAddFlags(out:number,a:number,b:number):void {
  emit(out,0x20,...u32(a),0x20,...u32(b),0x7c,0x21,...u32(TMP));
  emit(out,0x20,...u32(TMP),0x50,0x21,...u32(ZF));
  emit(out,0x20,...u32(TMP),0x42,0,0x53,0x21,...u32(SF));
  emit(out,0x20,...u32(TMP),0x20,...u32(a),0x56,0x21,...u32(CF));
  // OF = ((~(a^b)) & (a^r)) >> 63
  emit(out,0x20,...u32(a),0x20,...u32(b),0x85,0x42,-1,0x85,0x20,...u32(a),0x20,...u32(TMP),0x85,0x83,0x42,63,0x86,0x21,...u32(OF));
}

function setSubFlags(out:number,a:number,b:number):void {
  emit(out,0x20,...u32(a),0x20,...u32(b),0x7d,0x21,...u32(TMP));
  setSubFlagsFromTemp(out,a,b);
}

function setSubFlagsFromTemp(out:number,a:number,b:number):void {
  emit(out,0x20,...u32(TMP),0x50,0x21,...u32(ZF));
  emit(out,0x20,...u32(TMP),0x42,0,0x53,0x21,...u32(SF));
  emit(out,0x20,...u32(a),0x20,...u32(b),0x56,0x21,...u32(CF));
  // OF = ((a^b) & (a^r)) >> 63
  emit(out,0x20,...u32(a),0x20,...u32(b),0x85,0x20,...u32(a),0x20,...u32(TMP),0x85,0x83,0x42,63,0x86,0x21,...u32(OF));
}

function clearFlag(out:number,local:number):void {
  emit(out,0x41,0,0x21,...u32(local));
}

function conditionalBranch(out:number[],map:Map<number,number>,target:number,flag:number,compareOpcode:number,fallthrough:number|undefined):void {
  const taken=map.get(target);
  if(taken===undefined||fallthrough===undefined) throw new Error('conditional branch target missing');
  emit(out,0x20,...u32(flag),compareOpcode,0x04,0x40);
  setPc(out,taken);
  out.push(0x05);
  setPc(out,fallthrough);
  out.push(0x0b);
}

function emitSignedLess(out:number[],map:Map<number,number>,target:number,sf:number,of:number,fallthrough:number|undefined):void {
  const t=map.get(target); if(t===undefined||fallthrough===undefined) throw new Error('signed branch target missing');
  emit(out,0x20,...u32(sf),0x20,...u32(of),0x51,0x04,0x40);
  setPc(out,t); out.push(0x05); setPc(out,fallthrough); out.push(0x0b);
}
function emitSignedGreaterEqual(out:number[],map:Map<number,number>,target:number,sf:number,of:number,fallthrough:number|undefined):void {
  const t=map.get(target); if(t===undefined||fallthrough===undefined) throw new Error('signed branch target missing');
  emit(out,0x20,...u32(sf),0x20,...u32(of),0x51,0x04,0x40);
  setPc(out,t); out.push(0x05); setPc(out,fallthrough); out.push(0x0b);
}
function emitSignedLessEqual(out:number[],map:Map<number,number>,target:number,zf:number,sf:number,of:number,fallthrough:number|undefined):void {
  const t=map.get(target); if(t===undefined||fallthrough===undefined) throw new Error('signed branch target missing');
  emit(out,0x20,...u32(zf),0x45,0x04,0x40);
  setPc(out,t);
  out.push(0x05);
  emit(out,0x20,...u32(sf),0x20,...u32(of),0x51,0x04,0x40);
  setPc(out,t);
  out.push(0x05);
  setPc(out,fallthrough);
  out.push(0x0b);
}
function emitSignedGreater(out:number[],map:Map<number,number>,target:number,zf:number,sf:number,of:number,fallthrough:number|undefined):void {
  const t=map.get(target); if(t===undefined||fallthrough===undefined) throw new Error('signed branch target missing');
  emit(out,0x20,...u32(zf),0x45,0x04,0x40);
  out.push(0x05);
  emit(out,0x20,...u32(sf),0x20,...u32(of),0x51,0x04,0x40);
  setPc(out,t);
  out.push(0x05);
  setPc(out,fallthrough);
  out.push(0x0b);
}

function emitSyscall(out:number[]):void {
  // Linux x86-64 ABI: rax, rdi, rsi, rdx, r10, r8, r9.
  for (const reg of [0,7,6,2,10,8,9]) emit(out,0x20,...u32(reg));
  emit(out,0x10,1);
  emit(out,0x21,...u32(0));
}

function branchTo(out:number[],map:Map<number,number>,target:number):void {
  const id = map.get(target);
  if (id === undefined) throw new Error('branch target missing');
  setPc(out,id);
  out.push(0x0c,0);
}
function setPc(out:number,id:number):void {
  emit(out,0x41,...u32(id),0x21,...u32(PC));
}
function isTerminator(ins:X64Instruction):boolean {
  return [
    'ret','jmp_rel','jz_rel','jnz_rel','jl_rel','jle_rel','jg_rel','jge_rel','call_rel',
  ].includes(ins.mnemonic);
}

function activeData(offset:number,bytes:Uint8Array):Uint8Array {
  return concat([new Uint8Array([0x00]),new Uint8Array([0x41,...u32(offset),0x0b]),u32(bytes.length),bytes]);
}

function wasmHeader():Uint8Array {
  return new Uint8Array([0x00,0x61,0x73,0x6d,0x01,0x00,0x00,0x00]);
}
function funcType(params:number[],results:number[]):Uint8Array {
  return concat([
    new Uint8Array([0x60]),
    u32(params.length),
    new Uint8Array(params),
    u32(results.length),
    new Uint8Array(results),
  ]);
}
function name(value:string):Uint8Array {
  const bytes = new TextEncoder().encode(value);
  return concat([u32(bytes.length),bytes]);
}
function vec(values:Uint8Array[]):Uint8Array {
  return concat([u32(values.length),...values]);
}
function section(id:number,payload:Uint8Array):Uint8Array {
  return concat([new Uint8Array([id]),u32(payload.length),payload]);
}
function emit(out:number[],...bytes:number[]):void {
  out.push(...bytes);
}
function u32(value:number):number[] {
  const out:number[] = [];
  let n = value >>> 0;
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n) byte |= 0x80;
    out.push(byte);
  } while (n);
  return out;
}
function signedLeb(value:number|bigint):number[] {
  let n = BigInt(value);
  const out:number[] = [];
  let more = true;
  while (more) {
    const byte = Number(n & 0x7fn);
    const sign = (byte & 0x40) !== 0;
    n >>= 7n;
    more = !((n === 0n && !sign) || (n === -1n && sign));
    out.push(more ? byte | 0x80 : byte);
  }
  return out;
}
function concat(values:Uint8Array[]):Uint8Array {
  const length = values.reduce((n,v)=>n+v.length,0);
  const out = new Uint8Array(length);
  let p = 0;
  for (const value of values) {
    out.set(value,p);
    p += value.length;
  }
  return out;
}
function readU8(bytes:Uint8Array,p:number):number {
  if (p >= bytes.length) throw new Error('truncated instruction');
  return bytes[p];
}
function readU32(bytes:Uint8Array,p:number):number {
  if (p+4 > bytes.length) throw new Error('truncated imm32');
  return (bytes[p] | bytes[p+1]<<8 | bytes[p+2]<<16 | bytes[p+3]<<24) >>> 0;
}
function readI8(bytes:Uint8Array,p:number):number {
  const n = readU8(bytes,p);
  return n < 0x80 ? n : n - 0x100;
}
function readI32(bytes:Uint8Array,p:number):number {
  return readU32(bytes,p) | 0;
}
function readI64(bytes:Uint8Array,p:number):bigint {
  if (p+8 > bytes.length) throw new Error('truncated imm64');
  let value = 0n;
  for (let i=0;i<8;i++) value |= BigInt(bytes[p+i]) << BigInt(i*8);
  return BigInt.asIntN(64,value);
}
