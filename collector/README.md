# Coletor local de histórico — Crash

Este projeto não aposta, não lê credenciais e não envia dados para fora do VPS. A extensão lê somente os pares `ID da rodada + multiplicador` visíveis em `bc.game` e envia-os para `127.0.0.1`.

## 1. Iniciar o receptor local

Abra o PowerShell nesta pasta e rode:

```powershell
.\receiver.ps1
```

Teste em outra janela com `Invoke-WebRequest http://127.0.0.1:8765/health`.

Os arquivos diários ficarão em `data\crash-AAAA-MM-DD.csv` e `.jsonl`.

## 2. Carregar a extensão no Chrome

1. Abra `chrome://extensions`.
2. Ative **Modo do desenvolvedor**.
3. Clique **Carregar sem compactação** e selecione esta pasta.
4. Mantenha a aba do Crash aberta no VPS.

## 3. Iniciar junto com o VPS (opcional)

Em PowerShell com privilégios de administrador, execute `./install-autostart.ps1`. A tarefa `CrashHistoryCollector` iniciará o receptor no boot.

## Limitações importantes

- A extensão precisa estar instalada e o Chrome/aba precisam ficar abertos; o receptor local sozinho não captura nada.
- O coletor evita IDs repetidos e grava UTC para facilitar auditoria.
- Mudanças no layout do site podem exigir ajuste no `content.js`.
- Dados históricos descrevem resultados; não tornam rodadas futuras previsíveis.
