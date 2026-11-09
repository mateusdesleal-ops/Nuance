# Nuance

Plataforma de videoentrevistas para recrutadores: transcrição, roteiro por competência, copiloto de perguntas, indícios de emoção (base: Paul Ekman) com consentimento do candidato, e parecer preenchido no modelo da empresa.

> Protótipo em um único arquivo (`index.html`), sem build.

## Como rodar

Abra `index.html` no **Chrome do computador**. Para testar câmera, transcrição e leitura de expressões ao vivo, sirva por HTTP local (o Chrome bloqueia câmera em `file://` em alguns casos):

```bash
python3 -m http.server 8080
# acesse http://localhost:8080
```

- Demonstração: abra a sala de **Ana Souza** e clique em **Iniciar demonstração**.
- Candidato: o link do candidato termina em `#entrar` (ex.: `https://mateusdesleal-ops.github.io/Nuance/#entrar`) e mostra só a tela do código, o termo e a sala. Teste com o código **NU-7Q4K**.

## Funcionalidades

- **Antes:** roteiro por vaga, leitura do currículo, convite com código.
- **Aceite do candidato:** termo LGPD com opção de entrar sem a análise de expressões; aceite registrado com data, hora e versão.
- **Durante:** transcrição (Web Speech API, pt-BR), painel Ekman (MediaPipe Face Landmarker → 7 emoções), alerta de incongruência, perguntas sugeridas, checklist, marcação rápida, cronômetro por bloco, parecer ao vivo.
- **Depois:** avaliação por competência (Tem / Tem, mas pode melhorar / Não tem) sugerida pela IA, parecer no modelo da empresa, avaliação por pares, devolutiva, comparativo.
- **Modelos de parecer:** importar de .docx/.txt; a IA extrai tópicos e estilo.
- **Painel LGPD:** retenção, exportação e exclusão de dados.

Cada função pode ser ligada ou desligada por entrevista.

## Teste online (dois computadores)

1. Recrutador: abra o site, crie a entrevista (ou abra a sala) e clique em **Chamada online**.
2. Candidato: abra o link `…/Nuance/#entrar` no computador dele, digite o código e aceite o termo.
3. A chamada conecta direto entre os navegadores (WebRTC). A transcrição do candidato é feita no computador dele e enviada ao recrutador.

Backend: Supabase (projeto `nuance`, região São Paulo). A tabela `rooms` guarda só código, vaga, empresa, primeiro nome e o aceite; é acessada apenas por três funções (`nuance_upsert_room`, `nuance_get_room`, `nuance_set_consent`). Salas expiram em 3 dias. Transcrição, indícios e parecer continuam no navegador do recrutador.

Use fone de ouvido do lado do recrutador, para a transcrição dele não captar a voz do candidato. Redes corporativas podem bloquear a conexão direta; sem servidor TURN, teste com uma das pontas fora da rede da empresa.

## Limitações do protótipo

- Dados ficam no `localStorage` do navegador.
- Sem login de recrutador: quem souber o código pode sobrescrever a sala. Sem servidor TURN, algumas redes bloqueiam a chamada.
- As funções de IA usam a capacidade de IA do Claude quando aberto como artifact; fora dele, usam respostas padrão. Em produção, trocar por chamada a uma API de LLM no backend.

## Cuidados

Indícios de emoção são hipóteses para orientar perguntas, nunca critério de aprovação. A IA não registra saúde, religião ou outros dados sensíveis, e "Dados Pessoais e Familiares" vem desligado por padrão (Lei 9.029/95, LGPD art. 11).
