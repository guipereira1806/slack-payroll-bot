All logs
Search
Search

Live tail
GMT-3

Menu

==> Cloning from https://github.com/guipereira1806/slack-payroll-bot
==> Checking out commit de687bc27aa915700ce1bf953bbc03fe3263340b in branch master
==> Using Node.js version 22.12.0 (default)
==> Docs on specifying a Node.js version: https://render.com/docs/node-version
==> Using Bun version 1.1.0 (default)
==> Docs on specifying a Bun version: https://render.com/docs/bun-version
==> Running build command 'npm install'...
added 160 packages, and audited 161 packages in 2s
21 packages are looking for funding
  run `npm fund` for details
1 high severity vulnerability
To address all issues, run:
  npm audit fix
Run `npm audit` for details.
==> Uploading build...
==> Uploaded in 3.1s. Compression took 1.3s
==> Build successful 🎉
==> Deploying...
==> Running 'npm start'
> slack-corefone-payroll-bot-br@1.0.0 start
> node app.js
/opt/render/project/src/app.js:157
    await say(\`Olá! Recebi sua mensagem: "${text}". Se precisar de algo, estou aqui!\`);
              ^
SyntaxError: Invalid or unexpected token
    at wrapSafe (node:internal/modules/cjs/loader:1515:18)
    at Module._compile (node:internal/modules/cjs/loader:1537:20)
    at Object..js (node:internal/modules/cjs/loader:1708:10)
    at Module.load (node:internal/modules/cjs/loader:1318:32)
    at Function._load (node:internal/modules/cjs/loader:1128:12)
    at TracingChannel.traceSync (node:diagnostics_channel:322:14)
    at wrapModuleLoad (node:internal/modules/cjs/loader:219:24)
    at Function.executeUserEntryPoint [as runMain] (node:internal/modules/run_main:170:5)
    at node:internal/main/run_main_module:36:49
Node.js v22.12.0
