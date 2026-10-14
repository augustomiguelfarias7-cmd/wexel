import { gunzipSync } from "fflate";

/** Lê um asset ao lado do pacote (fetch no browser, filesystem no Node). */
export async function readPackagedAsset(relativePath: string): Promise<Uint8Array> {
  const url = new URL(relativePath, import.meta.url);
  if (url.protocol === "file:") {
    try {
      const nodeFs = await import("node:fs/promises");
      return new Uint8Array(await nodeFs.readFile(url));
    } catch (error) {
      throw new Error(`Não foi possível ler o asset empacotado ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Falha ao carregar asset ${relativePath}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

export async function readPackagedGzip(relativePath: string): Promise<Uint8Array> {
  return gunzipSync(await readPackagedAsset(relativePath));
}
