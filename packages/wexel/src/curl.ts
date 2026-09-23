/**
 * curl.ts — Wexel
 *
 * Implementa o curl no shell do Wexel com as flags mais usadas:
 *
 *   curl <url>
 *   curl -X POST <url>
 *   curl -H "Header: value" <url>
 *   curl -d '{"key":"val"}' <url>
 *   curl -o arquivo.json <url>        (salva no VFS)
 *   curl -s <url>                     (silencioso — sem progresso)
 *   curl -i <url>                     (inclui headers na saída)
 *   curl -L <url>                     (segue redirects)
 *   curl --json '<body>' <url>        (atalho: -X POST -H Content-Type:application/json)
 */

import type { WexelFileSystem } from "./index.js";

export interface CurlOptions {
  fs?:      WexelFileSystem;
  fetcher?: typeof fetch;
}

export interface CurlResult {
  stdout:   string;
  stderr:   string;
  exitCode: number;
}

export async function runCurl(
  args: string[],
  opts: CurlOptions = {},
): Promise<CurlResult> {
  const fetcher = opts.fetcher ?? fetch;
  const parsed  = parseCurlArgs(args);

  if (!parsed.url) {
    return {
      stdout: "",
      stderr: "curl: URL não especificada\nUso: curl [opções] <url>\n",
      exitCode: 2,
    };
  }

  const headers = new Headers(parsed.headers);
  let body: BodyInit | undefined;

  if (parsed.data) {
    body = parsed.data;
    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "application/x-www-form-urlencoded");
    }
  }

  if (parsed.json) {
    body = parsed.json;
    headers.set("Content-Type", "application/json");
    if (!parsed.method || parsed.method === "GET") parsed.method = "POST";
  }

  const method = parsed.method ?? (body ? "POST" : "GET");

  if (!parsed.silent) {
    process.stderr?.write?.(`  % Total    % Received % Xferd\n` +
      `  0     0    0     0    0     0      0      0 --:--:-- --:--:-- --:--:--     0\r`);
  }

  let response: Response;
  let finalUrl = parsed.url;

  try {
    let redirects = 0;
    let res = await fetcher(finalUrl, { method, headers, body, redirect: "manual" });

    while (parsed.followRedirects && [301, 302, 303, 307, 308].includes(res.status) && redirects < 10) {
      const loc = res.headers.get("Location");
      if (!loc) break;
      finalUrl  = loc.startsWith("http") ? loc : new URL(loc, finalUrl).toString();
      redirects++;
      res = await fetcher(finalUrl, { method: method === "POST" && res.status === 303 ? "GET" : method, headers, redirect: "manual" });
    }
    response = res;
  } catch (err) {
    return {
      stdout: "",
      stderr: `curl: (6) Could not resolve host: ${parsed.url}\n${err instanceof Error ? err.message : ""}\n`,
      exitCode: 6,
    };
  }

  // Monta stdout
  const bodyBytes  = new Uint8Array(await response.arrayBuffer());
  const bodyText   = new TextDecoder().decode(bodyBytes);
  const lines: string[] = [];

  if (parsed.includeHeaders) {
    lines.push(`HTTP/${response.status} ${response.statusText}`);
    response.headers.forEach((v, k) => lines.push(`${k}: ${v}`));
    lines.push("");
  }

  // Salva no VFS se -o foi passado
  if (parsed.outputFile && opts.fs) {
    try {
      // cria os diretórios pai se necessário
      const parts = parsed.outputFile.split("/").slice(0, -1);
      let p = "";
      for (const part of parts) { p += `/${part}`; opts.fs.mkdir(p); }
      opts.fs.write(parsed.outputFile, bodyBytes);
      if (!parsed.silent) {
        return {
          stdout: "",
          stderr: `  % Total\n100  ${bodyBytes.byteLength}  curl: saved to ${parsed.outputFile}\n`,
          exitCode: response.ok ? 0 : response.status,
        };
      }
      return { stdout: "", stderr: "", exitCode: response.ok ? 0 : response.status };
    } catch (err) {
      return {
        stdout: "",
        stderr: `curl: não foi possível salvar em ${parsed.outputFile}: ${err instanceof Error ? err.message : String(err)}\n`,
        exitCode: 1,
      };
    }
  }

  lines.push(bodyText);

  return {
    stdout:   lines.join("\n"),
    stderr:   parsed.silent ? "" : `\n100  ${bodyBytes.byteLength}\n`,
    exitCode: response.ok ? 0 : response.status,
  };
}

// ── Parser de args ────────────────────────────────────────────────────────────

interface ParsedCurl {
  url?:             string;
  method?:          string;
  headers:          Record<string, string>;
  data?:            string;
  json?:            string;
  outputFile?:      string;
  silent:           boolean;
  includeHeaders:   boolean;
  followRedirects:  boolean;
}

function parseCurlArgs(args: string[]): ParsedCurl {
  const result: ParsedCurl = {
    headers:         {},
    silent:          false,
    includeHeaders:  false,
    followRedirects: false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case "-X": case "--request":  result.method  = args[++i]; break;
      case "-H": case "--header":   parseHeader(args[++i], result.headers); break;
      case "-d": case "--data":
      case "--data-raw":            result.data    = args[++i]; break;
      case "--json":                result.json    = args[++i]; break;
      case "-o": case "--output":   result.outputFile = args[++i]; break;
      case "-s": case "--silent":   result.silent  = true; break;
      case "-i": case "--include":  result.includeHeaders = true; break;
      case "-L": case "--location": result.followRedirects = true; break;
      case "-v": case "--verbose":  /* ignorado no Wexel */ break;
      default:
        if (!arg.startsWith("-")) result.url = arg;
    }
    i++;
  }
  return result;
}

function parseHeader(h: string, target: Record<string, string>): void {
  const idx = h.indexOf(":");
  if (idx < 0) return;
  target[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
}
