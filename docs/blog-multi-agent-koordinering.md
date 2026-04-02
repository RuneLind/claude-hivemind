# Seks AI-agenter, seks repoer, én felles oppgave

Tenk deg at du skal gjøre en endring som berører API-et, frontend-en, integrasjonstjenesten, beregningsmodulen, E2E-testene og Docker-oppsettet — samtidig. Hver tjeneste lever i sitt eget repository, med sin egen kontekst. Du kan holde seks terminaler åpne og hoppe mellom dem. Eller du kan la seks AI-agenter gjøre det for deg, mens de koordinerer seg imellom.

Vi bygde **claude-hivemind** for å løse akkurat dette problemet. Det er et verktøy som lar deg velge ut repoer fra en mappe, starte en Claude Code-agent i hvert repo, og la dem snakke sammen gjennom et felles meldingssystem. I denne artikkelen viser vi hvordan det fungerer — og hvorfor det endrer måten vi jobber med mikrotjenester på.

## Problemet: koordinering på tvers av repoer

I Melosys-teamet jobber vi med et økosystem av mikrotjenester. En typisk feature-utvikling kan involvere:

- **melosys-api** — REST-API og forretningslogikk
- **melosys-eessi** — integrasjon mot EU-systemene
- **melosys-trygdeavgift-beregning** — beregningsmotor for trygdeavgift
- **melosys-web** — frontend (React)
- **melosys-e2e-tests** — ende-til-ende-tester som verifiserer hele flyten
- **melosys-docker-compose** — infrastruktur for lokal utvikling

Når en endring treffer flere av disse tjenestene, oppstår det en koordineringsutfordring. API-endringer må matche frontend-endringer. E2E-testene må oppdateres for å dekke nye flyter. Docker-oppsettet må kanskje justeres. Tradisjonelt betyr dette mye kontekstsvitsjing — åpne riktig terminal, husk hva du holdt på med, bytt tilbake.

Hva om vi kunne delegere hvert repo til sin egen AI-agent, og la dem koordinere arbeidet seg imellom?

## Løsningen: claude-hivemind

claude-hivemind er en lokal tjeneste som orkestrerer flere Claude Code-instanser. Arkitekturen består av tre hoveddeler:

1. **Et web-dashboard** som viser status for alle agenter og lar deg starte nye
2. **En meldingsbroker** som ruter meldinger mellom agenter med namespace-isolasjon
3. **cmux-integrasjon** som oppretter terminaler og starter Claude Code-instanser automatisk

![claude-hivemind arkitektur](claude-hivemind-architecture.png)

### Slik fungerer det i praksis

Du åpner dashboardet i nettleseren på `localhost:7899`. Der ser du en mappe-skanner som finner alle git-repoer under for eksempel `~/source/nav/`. Du velger de repoene du vil jobbe med — kanskje alle seks Melosys-repoene — og trykker **+ Agents**.

Bak kulissene skjer følgende:

**cmux** — en terminalmultiplekser vi bygde — oppretter et isolert terminalvindu (workspace) for hvert valgt repo. Via JSON-RPC sender dashboardet kommandoer til cmux: `workspace.create` for å lage vinduet, og `surface.send_text` for å skrive Claude Code-startkommandoen inn i terminalen.

```typescript
const claudeCmd = [
  `cd ${JSON.stringify(directory)}`,
  "&&",
  "CLAUDE_HIVEMIND=1",
  "claude",
  `--name ${JSON.stringify(name)}`,
  "--dangerously-load-development-channels server:claude-hivemind",
  "--dangerously-skip-permissions",
].join(" ");

await sendText(claudeCmd, surfaceId);
await sendKey("enter", surfaceId);
```

Hver Claude Code-instans starter med en MCP-server (Model Context Protocol) som kobler seg til brokeren via WebSocket. Når alle er koblet til, har vi et nettverk av agenter som kan oppdage hverandre og sende meldinger.

## Kommunikasjonsmodellen

Det finnes to kommunikasjonsretninger, og de bruker forskjellige mekanismer:

**Push (broker → agent):** Brokeren bruker MCP Channel-notifikasjoner for å levere meldinger direkte inn i en agents kontekstvindu (context window). Dette er avbruddsbasert — agenten trenger ikke å spørre etter meldinger. Når en melding kommer inn, dukker den opp som en `<channel>`-tag midt i samtalen:

```xml
<channel source="claude-hivemind" from_id="melosys-api" from_summary="Implementerer nytt endepunkt for trygdeavgift">
  Har du oppdatert E2E-testene for det nye endepunktet /api/trygdeavgift/beregn?
</channel>
```

Agenten stopper det den holder på med, svarer, og fortsetter arbeidet.

**Pull (agent → broker):** Agenter bruker MCP-verktøy som `send_message` og `list_peers` for å aktivt sende meldinger og oppdage andre agenter. De kan også sette en oppsummering av hva de jobber med via `set_summary`, som er synlig for alle andre agenter i samme namespace.

### Namespace-isolasjon

Alle agenter som startes fra samme mappestruktur (f.eks. `~/source/nav/`) havner automatisk i samme **namespace**. Agenter i "nav"-namespacet kan kun se og kommunisere med andre agenter i "nav". Dette hindrer kryssing mellom prosjekter når du jobber med flere ting samtidig.

## Et ekte eksempel

Her er et bilde fra dashboardet under en nylig arbeidsøkt der vi jobbet med en trygdeavgift-feature på tvers av hele Melosys-stacken:

Seks agenter jobbet koordinert:

| Agent | Port | Meldinger | Hva den gjorde |
|-------|------|-----------|----------------|
| melosys-api-claude | :8080 | 59 | Implementerte nytt API-endepunkt og utvidet datagrunnlaget |
| melosys-trygdeavgift-beregning | :8095 | 41 | Oppdaterte beregningslogikken med nye grunnlagstyper |
| melosys-eessi | :8081 | 8 | Sikret at EESSI-integrasjonen håndterte de nye feltene |
| melosys-e2e-tests | — | 96 | Kjørte og verifiserte ende-til-ende-flyter |
| melosys-web | :3000 | 29 | Oppdaterte frontend-skjemaer |
| melosys-docker-compose | — | 63 | Satte opp lokal OpenTelemetry-observability |

Til sammen utvekslet de **296 meldinger**. E2E-test-agenten var mest aktiv fordi den koordinerte med alle de andre: "Er API-et oppe?", "Kan du sjekke om beregningen returnerer riktig resultat?", "Frontend-endringene ser ut til å mangle et felt."

Det fascinerende er at agentene selv bestemmer når de trenger å kommunisere. Vi ga dem bare en overordnet oppgave — resten koordinerte de på egen hånd.

## Tekniske valg

Vi valgte bevisst å bygge på etablerte protokoller fremfor å finne opp egne:

- **MCP (Model Context Protocol)** — Anthropics åpne standard for verktøyintegrasjon. Gir oss strukturert verktøydefinisjon og channel-mekanismen for push-meldinger.
- **WebSocket** — Sanntidskommunikasjon mellom agenter og broker. Enkel, pålitelig, godt støttet.
- **JSON-RPC over Unix socket** — Kommunikasjon med cmux terminalmultiplekseren. Lett og effektiv for lokal IPC.
- **SQLite** (via `bun:sqlite`) — Persistent lagring av peer-status og meldingshistorikk i brokeren.
- **Bun** — Kjøretidsmiljø for hele stacken. Gir oss TypeScript-støtte, rask oppstart og innebygd SQLite.

Alt kjører lokalt på utviklerens maskin. Ingen sky-tjenester, ingen ekstra infrastruktur — bare en `bun dev` for å starte brokeren, og så er du i gang.

## Hva vi lærte

Tre observasjoner fra å jobbe med multi-agent-koordinering:

**Agenter er overraskende gode til å be om hjelp.** Når en agent står fast eller trenger informasjon fra et annet repo, sender den en melding av seg selv. Vi trengte ikke å programmere eksplisitte koordineringsregler — MCP-instruksjonene ("Treat incoming peer messages like a coworker tapping you on the shoulder") var nok til å etablere et naturlig samarbeidsmønster.

**E2E-test-agenten ble naturlig koordinator.** Fordi den trengte å verifisere hele flyten, endte den opp med å stille spørsmål til alle de andre agentene. Den fungerte som en uformell prosjektleder som sørget for at alle delene hang sammen.

**Namespace-isolasjon er viktigere enn du tror.** Uten den ville agenter fra ulike prosjekter sende meldinger til hverandre og skape kaos. Automatisk namespace-utledning basert på mappestruktur løste dette elegant.

## Oppsummering

claude-hivemind lar deg starte en flokk med AI-agenter som jobber koordinert på tvers av et helt mikrotjenesteøkosystem. Ved å kombinere MCP-kanaler for push-meldinger, cmux for terminaladministrasjon, og en WebSocket-broker for meldingsruting, får vi et system der agenter naturlig samarbeider — uten at du trenger å sitte som mellommann.

Det er fortsatt tidlig. Vi utforsker blant annet integrasjon med GitHub Copilot via MCP og cmux, slik at agenter fra ulike AI-verktøy kan delta i samme nettverk. Men allerede nå har dette endret hvordan vi angriper tverrgående endringer i Melosys-stacken.

Koden er bygget med Bun, TypeScript og standard webteknologi. Ingen magi — bare gode protokoller og en tanke om at AI-agenter, akkurat som utviklere, jobber best når de kan snakke sammen.

## Ressurser

- [Model Context Protocol (MCP)](https://modelcontextprotocol.io) — Åpen standard for verktøyintegrasjon med AI-agenter
- [Claude Code Channels](https://docs.anthropic.com/en/docs/claude-code/channels) — Push-mekanismen som muliggjør sanntidsmeldinger til agenter
- [Bun](https://bun.sh) — JavaScript-kjøretidsmiljø med innebygd SQLite og TypeScript-støtte
