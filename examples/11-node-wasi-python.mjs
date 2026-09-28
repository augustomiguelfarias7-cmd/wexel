/**
 * CPython REAL via node:wasi + python.wasm (sem Wasmtime).
 * node examples/11-node-wasi-python.mjs
 */
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { WASI } from "node:wasi";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pythonRoot = join(root, "packages/wexel/assets/cpython-3.14.7");
const bytes = await readFile(join(pythonRoot, "python.wasm"));
const work = join(tmpdir(), `wexel-ex11-${Date.now()}`);
await mkdir(work, { recursive: true });

const user = `
import sys
print("olá")
print("version=" + sys.version.split()[0])
print("impl=" + sys.implementation.name)
print("eq=" + str(2 ** 5))
`.trim();

const indented = user.split("\n").map((l) => "    " + l).join("\n");
const wrapped = `
import sys
class _Cap:
    def __init__(self, p):
        self.p, self.b = p, []
    def write(self, s):
        if s: self.b.append(s)
    def flush(self):
        pass
    def dump(self):
        open(self.p, "w", encoding="utf-8").write("".join(self.b))
out, err = _Cap("/work/__out__.txt"), _Cap("/work/__err__.txt")
sys.stdout, sys.stderr = out, err
code = 0
try:
${indented}
except Exception as e:
    err.write(type(e).__name__ + ": " + str(e) + "\\n")
    code = 1
finally:
    out.dump()
    err.dump()
    raise SystemExit(code)
`;
await writeFile(join(work, "main.py"), wrapped);

const wasi = new WASI({
  version: "preview1",
  args: ["python", "/work/main.py"],
  env: { PYTHONHOME: "/", PYTHONPATH: "/Lib:/work", PYTHONDONTWRITEBYTECODE: "1" },
  preopens: { "/": pythonRoot, "/work": work },
  returnOnExit: true,
});

const { instance } = await WebAssembly.instantiate(bytes, wasi.getImportObject());
const exit = wasi.start(instance);
const stdout = await readFile(join(work, "__out__.txt"), "utf8");
console.log("exit", exit);
process.stdout.write(stdout);
await rm(work, { recursive: true, force: true });
