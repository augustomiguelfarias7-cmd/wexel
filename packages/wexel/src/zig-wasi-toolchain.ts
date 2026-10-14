import { ConsoleStdout, Directory, File, OpenFile, PreopenDirectory, WASI, WASIProcExit } from "@bjorn3/browser_wasi_shim";
import { unzipSync } from "fflate";
import type { ExecResult } from "./index.js";
import type { WexelFileSystemLike } from "./filesystem.js";
import { readPackagedAsset, readPackagedGzip } from "./toolchain-assets.js";

const ASSET_BASE = "../assets/toolchains/zig/";
const COMPILER_ARGS = ["zigc.wasm", "build-exe", "input.zig", "-Dtarget=wasm32-wasi", "-fno-llvm", "-fno-lld", "-O", "ReleaseSmall"];

let zigAssetsPromise: Promise<{ compiler: Uint8Array; std: Directory }> | undefined;

export interface ZigCompileResult {
  outputPath: string;
  bytes: Uint8Array;
}

/** Compila Zig em um compilador Zig-WASM e executa a saída WASI gerada. */
export class WexelZigWasiToolchain {
  async compileFile(fs: WexelFileSystemLike, sourcePath: string, outputPath = defaultOutputPath(sourcePath)): Promise<ZigCompileResult> {
    const source = fs.readText(sourcePath);
    const { compiler, std } = await loadZigAssets();
    const compileStdout = new TextSink();
    const compileStderr = new TextSink();
    const compilerFiles = new Map<string, File>([["input.zig", new File(new TextEncoder().encode(source))]]);
    const fds = [
      new OpenFile(new File(new Uint8Array())),
      new ConsoleStdout((bytes) => compileStdout.push(bytes)),
      new ConsoleStdout((bytes) => compileStderr.push(bytes)),
      new PreopenDirectory(".", compilerFiles),
      new PreopenDirectory("/lib", new Map([["std", std]])),
      new PreopenDirectory("/cache", new Map()),
    ];
    const wasi = new WASI(COMPILER_ARGS, [], fds, { debug: false });
    const compilerModule = await WebAssembly.compile(toArrayBuffer(compiler));
    let status: number;
    try {
      const instance = await WebAssembly.instantiate(compilerModule, { wasi_snapshot_preview1: wasi.wasiImport });
      status = wasi.start(instance as unknown as Parameters<WASI["start"]>[0]);
    } catch (error) {
      if (error instanceof WASIProcExit) status = error.code;
      else throw error;
    }

    const outputFile = compilerFiles.get("input.wasm");
    if (status !== 0 || !outputFile?.data.byteLength) {
      const details = [compileStdout.text, compileStderr.text].filter(Boolean).join("");
      throw new Error(`Falha ao compilar ${sourcePath} com Zig WASM${status ? ` (exit ${status})` : ""}.${details ? `\n${details}` : ""}`);
    }

    const bytes = outputFile.data.slice();
    await WebAssembly.compile(bytes);
    fs.write(outputPath, bytes);
    return { outputPath, bytes };
  }

  async runFile(fs: WexelFileSystemLike, sourcePath: string, args: string[] = []): Promise<ExecResult> {
    try {
      const artifact = await this.compileFile(fs, sourcePath);
      return await this.runArtifact(fs, artifact.outputPath, args);
    } catch (error) {
      return { stdout: "", stderr: `${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 };
    }
  }

  async runArtifact(fs: WexelFileSystemLike, artifactPath: string, args: string[] = []): Promise<ExecResult> {
    try {
      const bytes = fs.read(artifactPath).slice();
      const stdout = new TextSink();
      const stderr = new TextSink();
      const wasi = new WASI(
        [artifactPath, ...args],
        [],
        [
          new OpenFile(new File(new Uint8Array())),
          new ConsoleStdout((chunk) => stdout.push(chunk)),
          new ConsoleStdout((chunk) => stderr.push(chunk)),
        ],
        { debug: false },
      );
      const module = await WebAssembly.compile(bytes);
      const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi.wasiImport });
      const exitCode = wasi.start(instance as unknown as Parameters<WASI["start"]>[0]);
      return { stdout: stdout.text, stderr: stderr.text, exitCode };
    } catch (error) {
      return { stdout: "", stderr: `Falha ao executar WASI ${artifactPath}: ${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 };
    }
  }
}

async function loadZigAssets(): Promise<{ compiler: Uint8Array; std: Directory }> {
  if (!zigAssetsPromise) {
    zigAssetsPromise = (async () => {
      const [compiler, archive] = await Promise.all([
        readPackagedGzip(`${ASSET_BASE}zigc.wasm.gz`),
        readPackagedAsset(`${ASSET_BASE}std.zip`),
      ]);
      const root = new Directory(new Map());
      for (const [name, data] of Object.entries(unzipSync(archive))) {
        const isDirectory = name.endsWith("/");
        const parts = name.split("/").filter(Boolean);
        let current = root;
        for (let index = 0; index < parts.length; index++) {
          const part = parts[index];
          const isLast = index === parts.length - 1;
          if (isLast && !isDirectory) {
            current.contents.set(part, new File(data));
          } else {
            if (!current.contents.has(part)) current.contents.set(part, new Directory(new Map()));
            const child = current.contents.get(part);
            if (!(child instanceof Directory)) throw new Error(`Estrutura inválida na stdlib Zig: ${name}`);
            current = child;
          }
        }
      }
      const std = root.contents.get("std");
      if (!(std instanceof Directory)) throw new Error("O pacote Zig-WASM não contém a pasta std/ esperada.");
      return { compiler, std };
    })();
  }
  return zigAssetsPromise;
}

class TextSink {
  private chunks: string[] = [];
  push(bytes: Uint8Array): void { this.chunks.push(new TextDecoder().decode(bytes)); }
  get text(): string { return this.chunks.join(""); }
}

function defaultOutputPath(sourcePath: string): string {
  return /\.zig$/i.test(sourcePath) ? sourcePath.replace(/\.zig$/i, ".wasm") : `${sourcePath}.wasm`;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
