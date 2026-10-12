import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { BootedKernel } from "./kernel-busybox-connector.js";

/** Inicializa o kernel Linux-WASM e devolve o par pronto pra WexelOptions. */
export async function bootKernel(opts: {
  vmlinuxPath: string;
  initramfsPath: string;
  workerPath: string;
  linuxFactory: (...args: any[]) => Promise<BootedKernel>; // linux() de linux-node.js
}): Promise<{ kernel: BootedKernel; kernelOutput: (l: (chunk: string) => void) => () => void }> {
  const vmlinuxModule = await WebAssembly.compile(fs.readFileSync(opts.vmlinuxPath));
  const initrd = zlib.gunzipSync(fs.readFileSync(opts.initramfsPath));

  const listeners: Array<(chunk: string) => void> = [];
  const kernelOutput = (l: (chunk: string) => void) => {
    listeners.push(l);
    return () => { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); };
  };
  const console_write = (msg: string) => { for (const l of [...listeners]) l(msg); };

  const kernel = await opts.linuxFactory(
    opts.workerPath,
    vmlinuxModule,
    "maxcpus=1 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc0",
    initrd.buffer.slice(initrd.byteOffset, initrd.byteOffset + initrd.byteLength),
    () => {}, // log
    console_write
  );

  await new Promise((r) => setTimeout(r, 2500)); // espera o boot terminar
  kernel.key_input("stty cols 2000\n"); // evita quebra de linha automatica (ver kernel-busybox-connector.ts)
  await new Promise((r) => setTimeout(r, 300));

  return { kernel, kernelOutput };
}
