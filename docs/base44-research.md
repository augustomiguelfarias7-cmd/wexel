# Pesquisa: Base44 e dependências externas

A documentação oficial do Base44 informa que pacotes npm podem ser adicionados conversando com a IA no editor do app. O usuário solicita o pacote pelo chat, revisa o pedido e aprova a instalação; não é necessário abrir um terminal ou executar manualmente `npm install`: https://docs.base44.com/Building-your-app/NPM-packages

A mesma documentação mostra que o Base44 trabalha com bibliotecas npm adicionadas ao app e que o fluxo de instalação passa por aprovação na interface da IA. Isso não significa que a IA possa baixar e executar arbitrariamente qualquer repositório sem aprovação ou que o ambiente aceite qualquer dependência de backend.

## Aplicação ao Star Code

O Star Code deve instruir a IA do Base44 a adicionar o Wexel como dependência Git explícita, com URL, branch/tag e subpath de importação. O formato técnico esperado pelo npm é uma dependência Git, por exemplo `git+https://github.com/OWNER/wexel.git#TAG`, ou uma URL GitHub equivalente, desde que o ambiente aceite esse tipo de dependência.

O modo loader-only do Wexel deve ser exposto como uma API de inicialização que carrega apenas o core, os artefatos pré-instalados e os adapters, sem criar arquivos de projeto e sem executar código automaticamente. A IA do Base44 precisa receber instruções do projeto descrevendo o pacote, sua API e a regra de inicialização segura; não se deve depender de ela descobrir sozinha o framework por pesquisa na web.
