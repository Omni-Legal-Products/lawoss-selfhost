# Adaptér resource servera

Kanonický samostatný TypeScript súbor je `skallars-auth.ts`. Nezasahuje do Auth provideru ani jeho build konfigurácie. Používa len Node a fetch. Overenie:

```sh
npm ci
npx tsc -p resource-server/tsconfig.json
node --test resource-server/skallars-auth.test.mjs
```

Nezávislé MCP repozitáre používajú presnú vendored kópiu v `src/skallars-auth.ts`, bez Git dependency, PAT alebo npm publish. Pri migrácii skopíruj súbor a porovnaj SHA256 oboch kópií. Novú verziu preber až po regresiách cieľového repozitára. DISQ testy obsahujú rozšírenú syntetickú HTTP integračnú sadu.

Konfigurácia vyžaduje `MCP_AUTH_MODE=shared-oauth`, `SKALLARS_AUTH_ISSUER`, `SKALLARS_AUTH_RESOURCE` a samostatný `SKALLARS_AUTH_SECRET` s aspoň 32 znakmi. Issuer musí byť HTTPS origin, resource presná HTTPS URL s cestou `/mcp`, bez query alebo fragmentu. `SKALLARS_AUTH_ALLOWED_ORIGINS` je voliteľný zoznam presných HTTPS origins oddelený čiarkou. Chýbajúci Origin aj vlastný resource origin sú povolené; Host musí byť presne resource host vrátane portu. Health kontrolu integrácia vykonáva pred guardom. HTTP výnimka je dostupná len explicitným argumentom `allowHttpForTests`, nikdy cez prostredie.

Integrácia publikuje `metadata()` na oboch protected-resource cestách a použije `challenge` pri 401. Pred preflight aj autentifikáciou kontroluje `checkRequest`. `authenticate` každý request introspektuje bez cache, s timeoutom najviac 5 sekúnd a maximom 64 KiB odpovede. Overuje issuer, audience, subjekt, tenant, scope a expiráciu. Chyby vracajú chýbajúcu identitu bez logovania tokenov alebo raw odpovedí.

HTTP handler spúšťaj cez `runWithIdentity(identity, callback)`. Stdio má explicitný `runWithIdentity("local", callback)`. `currentIdentity()` je iba serverom overený kontext, nie klientova hlavička. Stateful integrácia musí priradiť session ku `principalKey(identity)` a kontrolovať rovnaký kľúč pri každom použití session. DISQ je stateless; nový session store nepotrebuje.

TLS, secrets, registrácia resource, granty a cutover patria operátorovi. Tento adaptér nerieši vlastníctvo privátnych store, billing mapping ani rollout ďalších MCP.
