import { Wexel, DenoRuntime } from "../../packages/wexel/dist/index.js";

const status = document.querySelector("#status");
const output = document.querySelector("#output");
const button = document.querySelector("#run");

async function main() {
  const runtime = await Wexel.create({
    permissions: { network: false, storage: true, files: true, modules: true },
  });

  const deno = DenoRuntime.create({
    fs: runtime.fs,
    target: "browser",
    networkAllowed: false,
  });

  runtime.fs.write("/hello.ts", 'console.log("Hello from real Wexel Deno layer");');

  status.textContent = "Runtime pronto. VFS + Deno browser layer conectados.";
  button.disabled = false;

  button.addEventListener("click", async () => {
    button.disabled = true;
    output.textContent = "Executando...";
    try {
      const result = await deno.runFile("/hello.ts", "typescript");
      output.textContent = [
        result.stdout && "stdout:\n" + result.stdout,
        result.stderr && "stderr:\n" + result.stderr,
        "exitCode: " + result.exitCode,
      ].filter(Boolean).join("\n");
    } catch (error) {
      output.textContent = String(error);
    } finally {
      button.disabled = false;
    }
  });
}

main().catch((error) => {
  status.textContent = "Falha ao inicializar o Wexel.";
  output.textContent = String(error);
});
