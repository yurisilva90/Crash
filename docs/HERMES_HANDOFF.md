# Handoff para o agente Hermes

Este repositório é a fonte de verdade do painel Crash e do código do coletor.

## Repositório e publicação

- Repositório: `https://github.com/yurisilva90/Crash`
- Painel publicado: `https://yurisilva90.github.io/Crash/`
- Branch de produção: `main`
- O painel é o `index.html` na raiz.

## Componentes

- `index.html`: painel, mapa, simulador, estratégias e integração de leitura do Supabase.
- `collector/`: extensão e scripts do receptor local, sincronização, auditoria de gaps e watchdog.
- `collector/remote-control.sql`: RPCs de controle remoto do coletor.
- `data/dashboard.json`: snapshot estático de apoio; a fonte atual do histórico é o Supabase.
- `docs/`: documentação de operação e migração.

O código copiado para `collector/` é o código operacional sem os dados de execução. A pasta `collector/data/` é criada no servidor novo e não deve ser versionada.

## O que não deve ir para o GitHub

Nunca commitar senha, perfil do Chrome, token de controle, `supabase-sync.json`, `google-sync.json`, CSV/JSONL bruto ou logs. O arquivo `collector/supabase-sync.example.json` é apenas um modelo. Os valores reais devem ser inseridos como segredo no novo ambiente.

## Migração para uma VPS nova

1. Clonar o repositório no novo servidor e usar a branch `main`.
2. Instalar PowerShell, Node.js e Python, se os scripts de análise/sincronização forem usados.
3. Criar `collector/data/` e copiar, por canal seguro, o arquivo real `supabase-sync.json` e o `control-token.txt` atual. Se for necessário trocar credenciais, gerar novos tokens e atualizar o RPC no Supabase.
4. Executar `collector/receiver.ps1` e validar `http://127.0.0.1:8765/health`.
5. Carregar `collector/` como extensão sem compactação em `chrome://extensions` e abrir uma nova aba do Crash. O perfil do Chrome precisa de login próprio; ele não é migrado pelo Git.
6. Iniciar `collector/live-sync.ps1` e o watchdog/autostart conforme o ambiente. Validar o arquivo `collector/data/collector-status.json`.
7. Rodar a auditoria de gaps antes de considerar a migração concluída. O critério é receptor ativo, última rodada recente, Supabase sem atraso e `supabase_missing_count = 0`.
8. Só depois apontar o uso diário para o painel publicado.

## Configuração atual do painel

- Estratégias visíveis: `30x`, `20x` e `2x`.
- O preset `20x` usa payout 20.
- O fator por perda é derivado do payout: 20x = 1,05263; 30x = 1,03448.
- Os ciclos de referência do mapa usam 21 rodadas: 1–21, 22–42 e 43–63.
- A métrica de cores dos botões deve continuar sendo calculada pelo histórico; não substituir por um palpite manual.
- A simulação e a exposição usam a configuração global do cabeçalho: payout, rodadas, ciclos e níveis. A nomenclatura é C0/C1/C2 para ciclos dentro do nível e N0/N1/N2 para níveis; a aba Recuperação mantém somente banca e modo Recuperar/Lucrar.
- O cabeçalho usa `Nível máximo` e `Ciclo máximo` indexados a partir de zero: 0 = somente N0/C0, 1 = N0+N1 ou C0+C1. Os seletores R/L ficam ao lado de cada campo: R recupera o prejuízo; L recupera e adiciona a unidade de lucro correspondente. O painel, mapa e exposição leem esses valores diretamente.

## Regras para o Hermes

- Preservar a separação entre painel, coletor local e banco.
- Não alterar payout, limites de ciclo ou lógica de recuperação sem atualizar a simulação e registrar a alteração neste documento.
- Não operar nem apostar automaticamente; o coletor apenas captura, audita e sincroniza dados.
- Antes de qualquer deploy, executar `git diff`, validar a configuração e fazer uma auditoria de gaps.
- Se a extensão parar, verificar primeiro a aba do Crash, o receptor local e o watchdog; não fechar a aba que contém o script de operação sem autorização.

## Checklist de aceitação

- `/health` responde localmente.
- A extensão está carregada e a aba do Crash está aberta.
- O CSV local recebe novas rodadas sem duplicidade.
- O Supabase recebe as mesmas rodadas.
- Auditoria recente sem lacunas recuperáveis.
- Painel mostra data/hora e última rodada atuais.
