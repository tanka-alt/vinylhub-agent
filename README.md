# VinylHub Agent — n8n asendus

See on otsene koodiline vaste sinu n8n workflow'le "Webshop AI Agent (Gemini + Supabase)".
Sama süsteemiprompt, samad kaks tööriista (`search_albums`, `get_albums_by_genre`),
sama Gemini mudel, sama vestlusmälu põhimõte — lihtsalt Node.js/Express serverina,
mis ei sõltu n8n platvormist ega selle trial'ist.

## Enne käivitamist — turvalisus

**Ära kasuta vanu n8n-i credential'eid uuesti.** Loo mõlemale mõlemad värsked:

1. **Gemini API võti** — https://aistudio.google.com/apikey
2. **Supabase võti** — Supabase projekti Settings → API. Kui "albumid" tabelil on
   Row Level Security (RLS) sees, vajad `service_role` võtit (ainult serveri poolel,
   MITTE kunagi brauserisse/frontendisse). Kui RLS on väljas ja lugemine on avalik,
   piisab `anon` võtmest.

Mõlemad lähevad `.env` faili või hostimisplatvormi keskkonnamuutujatesse — mitte kunagi
koodi sisse ega vestlusesse Claude'iga.

## Kohalik käivitamine

```bash
npm install
cp .env.example .env
# täida .env failis GEMINI_API_KEY ja SUPABASE_URL / SUPABASE_KEY
npm start
```

Server käivitub pordil 3000 (või `PORT` env muutuja järgi). Testi:

```bash
curl http://localhost:3000/health

curl -X POST http://localhost:3000/webhook/chat \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"test1","chatInput":"Kas teil on Miles Davis albumeid?"}'
```

## Enne tootmisse viimist — kontrolli päring/vastus vormingut

Endpoint `/webhook/chat` eeldab sama kontrakti, mida n8n Chat Trigger / `@n8n/chat`
vidin kasutab: `{ action, sessionId, chatInput }` sisse, `{ output: "..." }` välja.
See on n8n dokumentatsiooni ja avaliku käitumise põhjal, aga **enne vana n8n
väljalülitamist kontrolli seda ise**:

1. Ava VinylHubi sait, kus vana n8n-põhine chat veel töötab
2. Ava brauseri DevTools → Network vahekaart
3. Saada chat'is üks sõnum ja vaata päringu (Request) ja vastuse (Response) JSON-i
4. Kui väljade nimed erinevad sellest, mida see server eeldab/tagastab, tuleb kohandada
   ainult `src/server.js` faili `/webhook/chat` route'i — ülejäänud loogika ei muutu.

## Frontendi muutmine

Kui VinylHubi sait kasutab ametlikku `@n8n/chat` vidinat, on frontendis tõenäoliselt
ainult üks konfiguratsiooniväli, mida vahetada — `webhookUrl`, mis praegu osutab n8n
instantsile. Vaheta see selle uue serveri aadressiks (nt
`https://sinu-uus-server.onrender.com/webhook/chat`), kui uus server on testitud ja
töötab. Muud frontendi koodi ei peaks vaja olema muuta.

## Majutus (hosting)

Kuna assistent peab olema pidevalt kättesaadav (mitte ainult demo), siin on kolm
mõistlikku tasuta/odavat varianti:

- **Render** (render.com) — tasuta "Web Service" tase. Lihtne: ühenda GitHub repo,
  sea env muutujad, deploy. Miinus: tasuta tase "magab" pärast ~15 min tegevusetust ja
  esimene päring pärast seda võtab kuni ~50 sekundit — chat'i esimene sõnum võib
  tunduda "kinni jäänud".
- **Railway** (railway.app) — tasuta krediit kuus, ei "maga" samamoodi nagu Render.
  Sobib hästi väikese projekti jaoks, aga krediit võib otsa saada suurema koormuse korral.
- **Fly.io** — tasuta tase väikese VM-i jaoks, jääb üldiselt "ärkvele". Veidi rohkem
  algseadistust (Dockerfile/`fly.toml`), aga stabiilseim variant kolmest.

Kui see on kooliprojekt/case study, mida hindaja vahel testib, on Render tasuta tase
tõenäoliselt piisav — lihtsalt hoiata, et esimene sõnum pärast pikemat pausi võib
võtta veidi aega.

## Teadaolevad piirangud (võrreldes n8n originaaliga)

- **Vestlusmälu on serveri mälus (in-memory)**, mitte andmebaasis. See tähendab:
  serveri taaskäivitumisel (nt Renderi deploy või "ärkamine" pärast magamist) kaovad
  pooleliolevad vestlused. n8n originaali `memoryBufferWindow` node käitus tehniliselt
  sarnaselt (samuti mälupõhine), nii et see pole tegelik regressioon — aga kui tahad
  seda parandada, on lihtsaim lahendus salvestada `src/agent.js` sessioonid Supabase
  tabelisse (uus tabel, nt `chat_sessions`) failimälu asemel.
- **`search_albums` tulemus on OR, mitte AND** artisti ja albumi väljade vahel (vt
  kommentaari `src/tools.js` failis) — see vastab tööriista kirjeldatud eesmärgile,
  aga kui märkad, et tulemused erinevad vana n8n versiooni omast, kontrolli seda kohta
  esimesena.
- **`GEMINI_MODEL` väärtus (`gemini-3.1-flash-lite`) on üle võetud otse vanast
  seadistusest** — pole kontrollitud, kas see mudel on Google'i praeguses API-s
  jätkuvalt saadaval. Kui saad käivitamisel mudeli-teemalise vea, kontrolli
  https://ai.google.dev/gemini-api/docs/models ja uuenda `.env` failis.

## Failistruktuur

```
src/
  server.js        Express server, /webhook/chat ja /health route'id
  agent.js         Gemini vestlusloogika + tööriistade väljakutsumise tsükkel
  tools.js         search_albums / get_albums_by_genre — Supabase päringud
  systemPrompt.js  Sama süsteemiprompt, mis oli n8n Agent node'is
```
