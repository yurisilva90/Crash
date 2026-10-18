# Instruções do projeto Crash

Antes de alterar qualquer coisa, leia `docs/HERMES_HANDOFF.md` e `docs/MIGRATION_CHECKLIST.md`.

## Ordem de prioridade

1. Preservar os dados já existentes e não apagar a VPS antiga durante a migração.
2. Nunca commitar credenciais, tokens, senhas, perfil do Chrome, CSV bruto ou logs.
3. Separar claramente painel (`index.html`), coletor (`collector/`) e banco Supabase.
4. Fazer auditoria de gaps e verificar `/health` antes de qualquer deploy.
5. Manter as estratégias visíveis como `30x`, `20x` e `2x`, com payout 20 no preset `20x` e ciclos de referência de 21 rodadas.

## Deploy

Alterações no painel devem ser testadas localmente, revisadas com `git diff`, commitadas na `main` e então publicadas. Não alterar a lógica de recuperação ou de coleta sem registrar a mudança em `docs/HERMES_HANDOFF.md`.

## Segurança operacional

O coletor captura e sincroniza histórico; ele não deve fazer apostas automaticamente. Para uma VPS nova, configurar os segredos por mecanismo seguro e criar um novo perfil de navegador autenticado. A validação deve ocorrer antes de desligar o servidor antigo.
