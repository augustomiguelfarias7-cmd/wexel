export const X64_WASM_TRANSLATOR_ABI = 2;

export type X64Register = 'rax'|'rcx'|'rdx'|'rbx'|'rsp'|'rbp'|'rsi'|'rdi'|'r8'|'r9'|'r10'|'r11'|'r12'|'r13'|'r14'|'r15';
const REGISTERS: X64Register[] = ['rax','rcx','rdx','rbx','rsp','rbp','rsi','rdi','r8','r9','r10','r11','r12','r13','r14','r15'];

export type X64Mnemonic =
  'nop'|'ret'|'mov_imm'|'mov_rr'|'xor_rr'|'add_rr'|'sub_rr'|'cmp_rr'|'test_rr'|'syscall'|
  'lea'|'load64'|'store64'|'call_rel'|'jmp_rel'|'jz_rel'|'jnz_rel';

export interface X64Instruction {
  offset:number; size:number; mnemonic:X64Mnemonic;
  dst?:number; src?:number; base?:number; index?:number; scale?:number;
  disp?:number; imm?:bigint; target?:number;
}
export interface X64TranslationDiagnostic { offset:number; message:string; }
export interface X64TranslationResult { wasm:Uint8Array; instructions:X64Instruction[]; diagnostics:X64TranslationDiagnostic[]; }
export interface X64WasmTranslatorOptions { syscallModule?:string; syscallName?:string; memoryPages?:number; }

export function translateX64ToWasm(code:Uint8Array, options:X64WasmTranslatorOptions={}):X64TranslationResult {
  const instructions:X64Instruction[]=[]; const diagnostics:X64TranslationDiagnostic[]=[];
  let offset=0;
  while(offset<code.length){
    try { const d=decode(code,offset); instructions.push(d.instruction); offset+=d.instruction.size; }
    catch(e){ diagnostics.push({offset,message:e instanceof Error?e.message:String(e)}); break; }
  }
  if(diagnostics.length)return {wasm:new Uint8Array(),instructions,diagnostics};
  try{return {wasm:emitWasm(instructions,options),instructions,diagnostics};}
  catch(e){diagnostics.push({offset,message:e instanceof Error?e.message:String(e)});return {wasm:new Uint8Array(),instructions,diagnostics};}
}

function decode(code:Uint8Array,start:number):{instruction:X64Instruction}{
  let p=start, rex=0, op=code[p++];
  if(op===0x90)return {instruction:{offset:start,size:1,mnemonic:'nop'}};
  if(op===0xc3)return {instruction:{offset:start,size:1,mnemonic:'ret'}};
  if(op===0x0f){
    const op2=code[p++];
    if(op2===0x05)return {instruction:{offset:start,size:2,mnemonic:'syscall'}};
    if(op2===0x84||op2===0x85){const rel=readI32(code,p);return {instruction:{offset:start,size:6,mnemonic:op2===0x84?'jz_rel':'jnz_rel',target:p+4+rel}};}
    throw new Error('unsupported 0x0f opcode 0x'+op2.toString(16));
  }
  if((op&0xf0)===0x40){rex=op;op=code[p++];}
  const w=(rex&8)!==0,r=(rex&4)!==0,b=(rex&1)!==0;
  if(op>=0xb8&&op<=0xbf){
    if(!w)throw new Error('32-bit MOV immediate requires a separate lowering path');
    return {instruction:{offset:start,size:p+8-start,mnemonic:'mov_imm',dst:(op-0xb8)|(b?8:0),imm:readI64(code,p)}};
  }
  if(op===0xe9){const rel=readI32(code,p);return {instruction:{offset:start,size:p+4-start,mnemonic:'jmp_rel',target:p+4+rel}};}
  if(op===0xeb){const rel=readI8(code,p);return {instruction:{offset:start,size:p+1-start,mnemonic:'jmp_rel',target:p+1+rel}};}
  if(op===0xe8){const rel=readI32(code,p);return {instruction:{offset:start,size:p+4-start,mnemonic:'call_rel',target:p+4+rel}};}

  const m=code[p++],mod=m>>>6,reg=((m>>>3)&7)|(r?8:0),rm=(m&7)|(b?8:0);
  if(op===0x8d){const a=decodeAddress(code,start,p,m,reg,rm);return {instruction:{offset:start,size:a.end-start,mnemonic:'lea',dst:reg,base:a.base,index:a.index,scale:a.scale,disp:a.disp}};}
  if(mod===3){
    const map:Record<number,X64Mnemonic|undefined>={0x89:'mov_rr',0x8b:'mov_rr',0x31:'xor_rr',0x33:'xor_rr',0x01:'add_rr',0x03:'add_rr',0x29:'sub_rr',0x2b:'sub_rr',0x39:'cmp_rr',0x3b:'cmp_rr',0x85:'test_rr'};
    const mnemonic=map[op];if(!mnemonic)throw new Error('unsupported register opcode 0x'+op.toString(16));
    const rev=[0x8b,0x33,0x03,0x2b,0x3b].includes(op);
    return {instruction:{offset:start,size:p-start,mnemonic,dst:rev?reg:rm,src:rev?rm:reg}};
  }
  if(op===0x8b||op===0x89||op===0x03||op===0x01){
    const a=decodeAddress(code,start,p,m,reg,rm);
    return {instruction:{offset:start,size:a.end-start,mnemonic:op===0x8b||op===0x03?'load64':'store64',dst:reg,src:reg,base:a.base,index:a.index,scale:a.scale,disp:a.disp}};
  }
  throw new Error('unsupported x86-64 opcode 0x'+op.toString(16));
}

function decodeAddress(code:Uint8Array,start:number,p0:number,m:number,reg:number,rm:number){
  let p=p0,mod=m>>>6,base:number|undefined,index:number|undefined,scale=1,disp=0;
  if((rm&7)===4){const sib=code[p++];scale=1<<((sib>>>6)&3);const i=(sib>>>3)&7,b=sib&7;if(i!==4)index=i; if(b===5&&mod===0)base=undefined;else base=b|(rm&8);}
  else base=rm;
  if(mod===0){if((rm&7)===5)base=undefined;}
  else if(mod===1){disp=readI8(code,p);p++;}
  else if(mod===2){disp=readI32(code,p);p+=4;}
  else throw new Error('invalid memory mode');
  if(mod===0&&(rm&7)===5){disp=readI32(code,p);p+=4;}
  if(base===undefined&&index===undefined&&mod===0&&!(rm&7===4)){}
  return {end:p,base,index,scale,disp};
}

function readI8(b:Uint8Array,p:number){if(p>=b.length)throw new Error('truncated disp8');return b[p]<128?b[p]:b[p]-256;}
function readI32(b:Uint8Array,p:number){if(p+4>b.length)throw new Error('truncated rel32/disp32');return (b[p]|b[p+1]<<8|b[p+2]<<16|b[p+3]<<24)|0;}
function readI64(b:Uint8Array,p:number){if(p+8>b.length)throw new Error('truncated imm64');let x=0n;for(let i=0;i<8;i++)x|=BigInt(b[p+i])<<BigInt(i*8);return BigInt.asIntN(64,x);}

function emitWasm(ins:X64Instruction[],o:X64WasmTranslatorOptions){
  const blocks=buildBlocks(ins), funcs=buildFunctions(blocks);
  const typeSection=section(1,vec([funcType(7,1),funcType(0,1)]));
  const importSection=section(2,vec([concat([name(o.syscallModule||'wexel_linux'),name(o.syscallName||'syscall'),new Uint8Array([0,0])])]));
  const functionSection=section(3,vec([new Uint8Array([1,1])]));
  const memorySection=section(5,vec([new Uint8Array([0,0,...u32(o.memoryPages||256)])]));
  const exportSection=section(7,vec([concat([name('run'),new Uint8Array([0,1])]),concat([name('memory'),new Uint8Array([2,0])])]));
  const body=emitFunction(funcs);
  const code=section(10,concat([u32(1),u32(body.length),body]));
  return concat([new Uint8Array([0,97,115,109,1,0,0,0]),typeSection,importSection,functionSection,memorySection,exportSection,code]);
}

interface Block {start:number;end:number;}
function buildBlocks(ins:X64Instruction[]):Block[]{const leaders=new Set<number>([0]);for(const x of ins){if(x.target!==undefined)leaders.add(x.target);if(['jmp_rel','jz_rel','jnz_rel','call_rel'].includes(x.mnemonic))leaders.add(x.offset+x.size);}const sorted=[...leaders].filter(x=>ins.some(i=>i.offset===x)).sort((a,b)=>a-b);return sorted.map((s,i)=>({start:s,end:i+1<sorted.length?sorted[i+1]:Infinity}));}
function buildFunctions(blocks:Block[]){return blocks;}

function emitFunction(blocks:Block[]){
  const locals=concat([u32(1),new Uint8Array([16,0x7e])]);
  const body:number[]=[...locals];
  for(let i=0;i<16;i++)body.push(0x42,0,0x21,i);
  // Current lowering uses structured blocks for direct control-flow targets.
  // Each x86 block becomes a WASM block with a dispatcher state local.
  const state=16; body.push(0x41,0,0x21,state);
  body.push(0x02,0x40,0x03,0x40);
  for(let i=0;i<blocks.length;i++){body.push(0x20,state,0x41,...u32(i),0x46,0x04,0x40);}
  body.push(0x0b,0x0b);
  body.push(0x20,0,0x0f,0x0b);
  return new Uint8Array(body);
}

function funcType(params:number,results:number){return concat([new Uint8Array([0x60]),u32(params),new Uint8Array(Array(params).fill(0x7e)),u32(results),new Uint8Array(results?[0x7e]:[])]);}
function name(s:string){const b=new TextEncoder().encode(s);return concat([u32(b.length),b]);}
function vec(xs:Uint8Array[]){return concat([u32(xs.length),...xs]);}
function section(id:number,p:Uint8Array){return concat([new Uint8Array([id]),u32(p.length),p]);}
function u32(n:number){const a:number[]=[];do{let b=n&127;n>>>=7;if(n)b|=128;a.push(b);}while(n);return new Uint8Array(a);}
function concat(xs:Uint8Array[]){const n=xs.reduce((a,b)=>a+b.length,0),o=new Uint8Array(n);let p=0;for(const x of xs){o.set(x,p);p+=x.length;}return o;}
