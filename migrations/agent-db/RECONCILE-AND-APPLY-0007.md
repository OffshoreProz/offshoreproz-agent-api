# Runbook — Reconciliar `d1_migrations` e aplicar a migration 0007

> **Status:** preparado 2026-06-18, **NÃO aplicado** (aguarda janela de manutenção do Victor).
> **DB alvo:** `offshoreproz-agent-api` (AGENT_DB, prod `<AGENT_DB_ID>`).

## Por que este runbook existe

Dois fatos verificados em produção (2026-06-18):

1. **Drift de tracking.** O banco tem TODAS as tabelas/colunas até a migration `0006`, mas a tabela `d1_migrations` só registra `0001` e `0002`:

   ```
   1 | 0001_initial_schema.sql | 2026-06-08 03:08:58
   2 | 0002_usage_tracking.sql | 2026-06-08 03:08:59
   ```

   As migrations `0003`–`0006` foram aplicadas **out-of-band** (via `d1 execute`, sem registrar). Por isso `wrangler d1 migrations apply` acha que `0003`–`0006` estão pendentes.

2. **`HAZARD`.** Se você rodar `wrangler d1 migrations apply` agora, ele tenta reaplicar `0003`–`0006` **antes** da `0007` e **FALHA** com "duplicate column name" / "table already exists" — possivelmente deixando o estado pela metade.

**Portanto:** primeiro reconcilie o tracking (registre `0003`–`0006` como aplicadas, sem rodar), depois aplique só a `0007`.

## Pré-requisitos

- [ ] Janela de manutenção combinada (a `0007` faz table-rebuild de `agent_formations`).
- [ ] **Backup fresh do AGENT_DB** tirado hoje:

  ```bash
  npx wrangler@4.95.0 d1 export offshoreproz-agent-api --remote \
    --output backups/agent-db_$(date +%Y%m%d_%H%M%S).sql
  ```

- [ ] Confirmar o estado atual (deve mostrar só 0001 e 0002):

  ```bash
  npx wrangler@4.95.0 d1 execute offshoreproz-agent-api --remote \
    --command "SELECT id, name FROM d1_migrations ORDER BY id"
  ```

## Passo 1 — Reconciliar o tracking (registrar 0003–0006 sem rodar)

`d1_migrations` é `(id INTEGER PK AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP)`. Registre as 4 migrations já aplicadas:

```bash
npx wrangler@4.95.0 d1 execute offshoreproz-agent-api --remote --command "
INSERT OR IGNORE INTO d1_migrations (name) VALUES
  ('0003_portal_sync_status.sql'),
  ('0004_action_tokens.sql'),
  ('0005_documents.sql'),
  ('0006_beta_waitlist.sql');
"
```

Verifique (deve listar 0001–0006):

```bash
npx wrangler@4.95.0 d1 execute offshoreproz-agent-api --remote \
  --command "SELECT id, name FROM d1_migrations ORDER BY id"
```

## Passo 2 — Aplicar a 0007 (agora roda só ela)

Com 0003–0006 registradas, o migration system vê só a `0007` pendente:

```bash
# (do diretório workers/agent-api, onde wrangler.jsonc define migrations_dir)
npx wrangler@4.95.0 d1 migrations apply offshoreproz-agent-api --remote
```

> Alternativa equivalente (bypass do migration system), se preferir aplicar o arquivo direto e só então registrar:
> ```bash
> npx wrangler@4.95.0 d1 execute offshoreproz-agent-api --remote \
>   --file migrations/agent-db/0007_add_kyc_approved_status.sql
> npx wrangler@4.95.0 d1 execute offshoreproz-agent-api --remote \
>   --command "INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0007_add_kyc_approved_status.sql')"
> ```

## Passo 3 — Verificar

```bash
# 1) O CHECK agora inclui kyc_approved:
npx wrangler@4.95.0 d1 execute offshoreproz-agent-api --remote \
  --command "SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_formations'" \
  | grep -o "kyc_approved" && echo "OK: kyc_approved presente"

# 2) Contagem de linhas bate com o backup (nenhuma perda no rebuild):
npx wrangler@4.95.0 d1 execute offshoreproz-agent-api --remote \
  --command "SELECT COUNT(*) AS n FROM agent_formations"

# 3) Os 9 índices foram recriados:
npx wrangler@4.95.0 d1 execute offshoreproz-agent-api --remote \
  --command "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='agent_formations'"

# 4) Smoke test da API:
curl -s https://api.offshoreproz.com/health
```

## Passo 4 — Repetir em staging

Faça o mesmo em `offshoreproz-agent-api-staging` (id `<AGENT_DB_STAGING_ID>`). Confirme primeiro o estado de tracking dele — a drift pode ser diferente.

## Rollback

Se algo der errado no rebuild, restaure o backup:

```bash
npx wrangler@4.95.0 d1 execute offshoreproz-agent-api --remote \
  --file backups/agent-db_<TIMESTAMP>.sql
```

## Guard de CI (impedir a re-drift)

Depois de aplicado, adicione o teste de paridade descrito em `13-CHECKLIST-DEV.md`: comparar a enum `FormationStatus` em `src/types.ts` com a lista do CHECK em produção — falha o CI se divergirem.
