# Demo para Clientes — Uma IA abrindo uma empresa

Roteiro completo para demonstrar, ao vivo, uma IA abrindo uma empresa pela
OffshoreProz Agent API (MCP). Formato: **Claude Desktop + tela**, em modo
**sandbox** (teste — sem cobrança real, sem registro real).

A história que o cliente vê: você pede em português, a IA faz todo o trabalho de
montagem sozinha, e a única coisa que sobra para o humano é o que a lei exige
(confirmar identidade, pagar, assinar) — numa página limpa, com um clique.

---

## Passo 0 — Instalar o Claude Desktop (uma vez)

1. Baixe em **https://claude.ai/download** (versão Mac) e faça login.
2. Garanta que tem **Node.js** instalado (`node -v`). O `npx` vem junto e é usado
   pelo `mcp-remote`.

## Passo 1 — Conectar a Agent API ao Claude Desktop (uma vez)

Edite o arquivo de config do Claude Desktop:

`~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "offshoreproz": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://api.offshoreproz.com/mcp", "--header", "Authorization:${OPZ_AUTH}"],
      "env": { "OPZ_AUTH": "Bearer op_test_SUA_CHAVE_AQUI" }
    }
  }
}
```

> **Importante (corrige um erro comum na demo):** a chave `op_test_` vai no
> **header**, então a IA NÃO precisa chamar `offshoreproz_register` ao vivo. O
> `register` é rate-limited (5/hora por email, 10/hora por IP) — se você ensaiar
> várias vezes, ele bloqueia e trava a demo. Com a chave no header, todas as
> tools autenticadas (incluindo `create_formation`) funcionam direto.
>
> Pegue uma chave `op_test_` uma vez (quando não estiver rate-limited) rodando
> `node scripts/demo.mjs` e copiando a que ele imprime, ou via
> `offshoreproz_register`. Ela é durável (não expira). O `${OPZ_AUTH}` com a env
> evita um bug do Claude Desktop que remove o espaço em "Bearer xxx".

Reinicie o Claude Desktop. No canto da caixa de mensagem deve aparecer o ícone de
ferramentas 🔌 com as tools `offshoreproz_*` (são 14).

## Passo 2 — Preparar as abas do navegador (antes da call)

- Aba 1: deixe pronta para colar o **link de confirmação** que a IA vai gerar.
- Aba 2 (opcional, efeito "ao vivo"): abra **https://webhook.site** — ele gera
  uma URL única; você pode pedir para a IA registrar um webhook nela e as
  notificações aparecem em tempo real na tela.

## Passo 3 — Ensaiar (sempre antes de uma demo real)

No terminal, dentro de `workers/agent-api`:

```bash
# Use a MESMA chave op_test_ do header do Claude Desktop para não gastar o rate
# limit do register (recomendado para ensaiar várias vezes):
OPZ_KEY=op_test_SUA_CHAVE node scripts/demo.mjs

# Sem OPZ_KEY ele chama register (rate-limited: 5/h por email, 10/h por IP):
node scripts/demo.mjs

# Marshall Islands DAO LLC em vez de Wyoming:
OPZ_KEY=op_test_SUA_CHAVE JURISDICTION=MI node scripts/demo.mjs

# Gera um link de confirmação FRESCO (não consumido) para clicar ao vivo:
OPZ_KEY=op_test_SUA_CHAVE STOP_AT_LINK=1 node scripts/demo.mjs
```

Use o `STOP_AT_LINK=1` na hora da demo de verdade se quiser um link garantido
para clicar na tela (a IA também gera um durante a conversa).

---

## A demo ao vivo (3 a 4 minutos)

### O prompt que você digita no Claude Desktop

**Wyoming (padrão, rápido e barato — comece por este):**

```
Use as ferramentas da OffshoreProz para abrir uma empresa para mim.
Você já está autenticado — NÃO precisa registrar nenhuma chave.

Quero uma Wyoming LLC chamada "Minha Startup AI LLC".
Meu nome é Victor Tavares, email demo@offshoreproz.com,
endereço Rua Exemplo 100, São Paulo, Brasil.

Faça o processo me explicando cada passo:
1. Me mostre as jurisdições e preços
2. Me dê o orçamento detalhado da Wyoming
3. Abra a empresa em modo de teste
4. Me mostre o link de confirmação e a página do portal
```

> A linha "você já está autenticado, não registre chave" é importante: a chave
> já está no header (Passo 1 do setup), então pedir register só arrisca o rate
> limit e trava a demo. Se mesmo assim a IA tentar registrar e falhar, diga:
> *"ignore o registro, você já tem chave — siga para o orçamento e a criação."*

**Marshall Islands (o momento "uau" — a IA pode ser dona legal):**

```
Use as ferramentas da OffshoreProz (você já está autenticado, não registre chave)
para abrir uma Marshall Islands DAO LLC chamada "Autonomous Agent DAO LLC",
governança on-chain na rede Base.
Custodiante humano: Victor Tavares, demo@offshoreproz.com, Rua Exemplo 100,
São Paulo, Brasil, 100% de governança.
Me mostre o orçamento ($9.500) e abra em modo de teste.
Depois me dê o link de confirmação.
```

### O que acontece na tela (e a narração)

1. **A IA se registra e consulta tudo sozinha.**
   > "Isso é uma IA. Eu só pedi em português, uma vez. Ela está se cadastrando
   > e consultando as opções sozinha — sem formulário, sem atendente."

2. **A IA mostra o orçamento e abre a empresa.**
   > "Wyoming, $499, pronta em 1-2 dias. Ela acabou de criar a empresa e gerou
   > um link seguro para eu, o dono, confirmar."

3. **Você abre o link de confirmação no navegador.**
   A página mostra: nome da empresa, jurisdição, preço, e um aviso **"Sandbox /
   test formation"**, com o botão **Confirmar**.
   > "Esse é o único momento que exige uma pessoa: confirmar. Isto aqui é nosso
   > modo de teste seguro — não criamos uma empresa real durante a demo."

4. **Você clica em Confirmar.** A formação avança para a verificação de
   identidade (KYC). Em modo de teste, cada etapa de compliance (KYC →
   pagamento → assinatura → registro) é simulada.
   > "A partir daqui são as etapas que a lei exige de uma pessoa: provar quem é,
   > pagar e assinar. No modo real, é onde entram documento, cartão e assinatura
   > digital. No teste, simula na hora."

5. **(Opcional) De volta ao Claude Desktop**, peça: *"Me mostre o status e o
   histórico dessa formação."* A IA chama `get_formation_status` e
   `get_formation_events` e mostra a linha do tempo.
   > "E tudo fica registrado e auditável — cada passo, com data e hora."

### O fecho

> "A IA faz 90% do trabalho — o chato. O humano só faz o que a lei obriga ser
> uma pessoa: confirmar quem é e assinar. Esse é o futuro: a sua IA monta a
> empresa, você só aprova."

---

## Como o fluxo realmente funciona (para você saber responder)

- A confirmação é uma **escada de 4 passos**: `owner_confirmation` → `kyc_pending`
  → `payment_pending` → `signature_pending` → `filing_ready`. Cada passo é uma
  ação do humano (no modo real) e é **simulado na hora** no sandbox.
- O link `act_*` é de **uso único** e vale 14 dias. Se expirar/for usado, peça à
  IA: *"reemita o link de confirmação"* (tool `offshoreproz_reissue_action_link`).
- A página de confirmação ([app/portal/actions/[token]/page.tsx](../../../app/portal/actions/%5Btoken%5D/page.tsx))
  lê o token direto da Agent API — funciona para formação sandbox **sem** depender
  de sync com o portal.
- Sandbox (`op_test`) nunca cobra nem registra de verdade. O modo real
  (`op_live`) exige Stripe + DocuSeal configurados e **não** deve ser usado em demo.

## Pré-flight checklist (antes de cada demo)

- [ ] Claude Desktop aberto, ícone 🔌 mostrando as tools `offshoreproz_*`
- [ ] Internet ok; `node scripts/demo.mjs` rodou limpo no ensaio
- [ ] Aba do navegador pronta para o link de confirmação
- [ ] (Opcional) webhook.site aberto
- [ ] Prompt escolhido (Wyoming para rápido, Marshall para o "uau") copiado

## Troubleshooting

| Sintoma | Causa / solução |
|---|---|
| Tools `offshoreproz_*` não aparecem no Claude Desktop | Config errada ou app não reiniciado. Confira o JSON e reinicie. `npx mcp-remote` precisa de Node. |
| "Rate limit" no register / a IA não consegue criar chave | **Causa raiz mais comum.** O `register` é limitado a 5/hora por email e 10/hora por IP. Solução: já está resolvido — a chave vai no header (Passo 1), a IA não deve registrar. Confirme que `OPZ_AUTH` está no config. Para liberar o register: espere ~1h ou troque o email. |
| `create_formation` diz "authentication required" | A chave do header está errada/ausente. Cheque `env.OPZ_AUTH` = `Bearer op_test_...` no config e reinicie. Teste a chave: `OPZ_KEY=op_test_... node scripts/demo.mjs`. |
| Link de confirmação "expirado/usado" | Use a tool `offshoreproz_reissue_action_link` ou rode `STOP_AT_LINK=1 node scripts/demo.mjs` para um link fresco. |
| Página do portal não carrega a empresa | Token errado/consumido. Gere outro. O endpoint `GET /v1/actions/{token}` deve retornar `sandbox: true`. |
| Quero o ciclo inteiro completando na tela | Rode `node scripts/demo.mjs` (sem `STOP_AT_LINK`) — ele caminha até `filing_ready`. |
