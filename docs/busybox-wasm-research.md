# Pesquisa: BusyBox em WebAssembly

A referência `mayflower/busybox-wasm` documenta BusyBox 1.37.0 compilado com Emscripten 4.x, distribuindo `busybox.js` e `busybox.wasm`. O projeto mantém scripts de build em vez de ser um fork completo do BusyBox. A mesma página documenta uma saída ES module para Deno e um runner que carrega os artefatos WASM: https://github.com/mayflower/busybox-wasm/blob/master/README.md

## Decisões para o Wexel

O BusyBox deve ser tratado como um módulo WASM separado e carregado sob demanda, não copiado como uma implementação TypeScript de comandos. A integração precisa receber os artefatos `busybox.js`/`busybox.wasm` e conectar stdin, stdout, stderr e filesystem virtual. No navegador, o modo correto é Emscripten/ESM com APIs de host controladas; no Node.js/backend, o mesmo módulo pode ser executado com o runner adequado.

O Wexel não deve chamar um BusyBox nativo do sistema do usuário quando o objetivo for portabilidade. Também não deve declarar Bash completo se o artefato BusyBox fornecido não incluir o applet `ash` e a infraestrutura necessária. A configuração do build deve fixar a versão, a origem e o checksum dos binários.
