# Wexel Browser Demo

Este demo conecta o Wexel VFS à camada Deno unificada no browser.

## Rodar

Na raiz do repositório, execute:

npm run build
node examples/browser-demo/server.mjs

Abra http://localhost:4173.

O servidor envia COOP/COEP para habilitar SharedArrayBuffer, necessário para o caminho Deno browser quando o ambiente oferece os recursos exigidos.
