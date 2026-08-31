# Pesquisa: Python 3.14 e WebAssembly

A página oficial de release do Python informa que **Python 3.14.7** foi lançado em **5 de agosto de 2026** e é a sétima versão de manutenção da série 3.14: https://www.python.org/downloads/release/python-3147/

A documentação oficial do Python 3.14.7 descreve `wasm32-emscripten` e `wasm32-wasi` como plataformas que fornecem apenas um subconjunto das APIs POSIX. Runtimes WebAssembly e navegadores são sandboxed e têm acesso limitado ao host e a recursos externos. APIs de processos, subprocessos, sinais, IPC, partes de rede e certas operações de filesystem podem estar indisponíveis ou funcionar de forma diferente: https://docs.python.org/3.14/library/intro.html

## Decisões para o Wexel

O alvo do runtime Python será CPython **3.14.7**, fixado por versão e checksum quando o artefato for incorporado. Não será usado Pyodide ou micropip como mecanismo principal. O Wexel deverá fornecer uma camada de host para stdout, stderr, filesystem virtual, permissões e rede controlada.

A arquitetura precisa distinguir o modo browser (Emscripten ou WASM compatível com APIs de browser), o modo Node.js/backend (WASI ou runtime WASM de servidor) e o host de testes. Não se deve prometer Bash, fork, subprocessos ou sockets TCP irrestritos dentro do navegador; o shell será uma implementação compatível e controlada sobre a VFS e APIs de host.
