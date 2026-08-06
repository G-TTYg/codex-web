#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function readArg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return fallback;
  }
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}.`);
  }
  return value;
}

const asarRoot = path.resolve(readArg("--root", "scratch/asar"));
const requestedAppVersion = readArg("--app-version", "");
const webviewRoot = path.join(asarRoot, "webview");
const assetsRoot = path.join(webviewRoot, "assets");
const buildRoot = path.join(asarRoot, ".vite", "build");

function assertDirectory(directoryPath) {
  if (
    !fs.existsSync(directoryPath) ||
    !fs.statSync(directoryPath).isDirectory()
  ) {
    throw new Error(`Expected directory: ${directoryPath}`);
  }
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function writeText(filePath, text) {
  fs.writeFileSync(filePath, text);
}

function countOccurrences(text, needle) {
  let count = 0;
  let index = -1;
  while ((index = text.indexOf(needle, index + 1)) !== -1) {
    count += 1;
  }
  return count;
}

function replaceOnce(filePath, before, after, label) {
  const text = readText(filePath);
  if (text.includes(after)) {
    console.log(`Already patched ${label}`);
    return;
  }

  const count = countOccurrences(text, before);
  if (count !== 1) {
    throw new Error(
      `Expected one match for ${label} in ${filePath}, found ${count}.`,
    );
  }

  writeText(filePath, text.replace(before, after));
  console.log(`Patched ${label}`);
}

function insertAfterOnce(filePath, anchor, insertion, marker, label) {
  const text = readText(filePath);
  if (text.includes(marker)) {
    console.log(`Already patched ${label}`);
    return;
  }

  const count = countOccurrences(text, anchor);
  if (count !== 1) {
    throw new Error(
      `Expected one anchor for ${label} in ${filePath}, found ${count}.`,
    );
  }

  writeText(filePath, text.replace(anchor, `${anchor}${insertion}`));
  console.log(`Patched ${label}`);
}

function insertBeforeOnce(filePath, anchor, insertion, marker, label) {
  const text = readText(filePath);
  if (text.includes(marker)) {
    console.log(`Already patched ${label}`);
    return;
  }

  const count = countOccurrences(text, anchor);
  if (count !== 1) {
    throw new Error(
      `Expected one anchor for ${label} in ${filePath}, found ${count}.`,
    );
  }

  writeText(filePath, text.replace(anchor, `${insertion}${anchor}`));
  console.log(`Patched ${label}`);
}

function removeCspMeta(filePath) {
  const text = readText(filePath);
  const marker = 'http-equiv="Content-Security-Policy"';
  const count = countOccurrences(text, marker);
  if (count === 0) {
    console.log("Already patched webview CSP metadata");
    return;
  }
  if (count !== 1) {
    throw new Error(
      `Expected at most one CSP meta tag in ${filePath}, found ${count}.`,
    );
  }

  const pattern =
    /\s*<meta(?=[^>]*http-equiv="Content-Security-Policy")[^>]*\/?>/;
  const matches = text.match(pattern);
  if (!matches || matches.length !== 1) {
    throw new Error(`Could not isolate the CSP meta tag in ${filePath}.`);
  }

  writeText(filePath, text.replace(pattern, ""));
  console.log("Patched webview CSP metadata");
}

function findFile(label, directoryPath, predicate, namePredicate = () => true) {
  const files = fs
    .readdirSync(directoryPath)
    .filter((name) => name.endsWith(".js") && namePredicate(name));
  const matches = files.filter((name) => {
    const filePath = path.join(directoryPath, name);
    return predicate(readText(filePath), name);
  });

  if (matches.length !== 1) {
    throw new Error(
      `Expected one file for ${label} under ${directoryPath}, found ${matches.length}: ${matches.join(", ")}`,
    );
  }

  return path.join(directoryPath, matches[0]);
}

function findAssetFile(label, predicate, namePattern = null) {
  return findFile(
    label,
    assetsRoot,
    predicate,
    namePattern == null ? undefined : (name) => namePattern.test(name),
  );
}

assertDirectory(asarRoot);
assertDirectory(webviewRoot);
assertDirectory(assetsRoot);
assertDirectory(buildRoot);

const desktopPackagePath = path.join(asarRoot, "package.json");
const desktopPackage = JSON.parse(readText(desktopPackagePath));
const desktopAppVersion = String(desktopPackage.version ?? "");
const desktopAppBrand = String(desktopPackage.codexAppBrand ?? "");
if (!desktopAppVersion) {
  throw new Error(`Expected a desktop version in ${desktopPackagePath}.`);
}
if (desktopAppBrand !== "chatgpt") {
  throw new Error(
    `Expected codexAppBrand=chatgpt in ${desktopPackagePath}, found ${desktopAppBrand || "<missing>"}.`,
  );
}
if (requestedAppVersion && requestedAppVersion !== desktopAppVersion) {
  throw new Error(
    `Requested ASAR version ${requestedAppVersion}, but ${desktopPackagePath} contains ${desktopAppVersion}.`,
  );
}

console.log(
  `Patching ChatGPT Desktop ASAR ${desktopAppVersion} (Electron ${desktopPackage.devDependencies?.electron ?? "unknown"}).`,
);

const indexHtmlPath = path.join(webviewRoot, "index.html");
const indexHtml = readText(indexHtmlPath);
const htmlEol = indexHtml.includes("\r\n") ? "\r\n" : "\n";
insertAfterOnce(
  indexHtmlPath,
  "    <!-- PROD_BASE_TAG_HERE -->",
  `${htmlEol}    <base href="/" />`,
  '<base href="/" />',
  "webview base URL",
);
insertAfterOnce(
  indexHtmlPath,
  "    <!-- PROD_CSP_TAG_HERE -->",
  `${htmlEol}    <script type="module" src="./assets/preload.js"></script>`,
  'src="./assets/preload.js"',
  "webview preload",
);
insertAfterOnce(
  indexHtmlPath,
  "    <title>Codex</title>",
  `${htmlEol}    <link rel="icon" type="image/svg+xml" href="./favicon.svg" />${htmlEol}    <link rel="manifest" href="/manifest.json" />`,
  'rel="manifest" href="/manifest.json"',
  "webview favicon and PWA manifest",
);
insertBeforeOnce(
  indexHtmlPath,
  '    <script type="module" crossorigin',
  `    <style>${htmlEol}      .main-surface {${htmlEol}        --spacing-token-safe-header-left: 0px;${htmlEol}      }${htmlEol}    </style>${htmlEol}`,
  "--spacing-token-safe-header-left: 0px",
  "webview safe-header style",
);
removeCspMeta(indexHtmlPath);

// Since 26.721, the renderer modules that used to have separate fingerprinted
// chunks are rolled into app-initial. Locate it by independent semantic anchors
// so a filename change is harmless while a changed contract still fails closed.
const appInitialPath = findAssetFile(
  "app-initial renderer bundle",
  (text) =>
    text.includes("v5Compat:!0") &&
    text.includes("app-shell-bottom-panel-launcher-visible") &&
    text.includes("composer-suggestion-ui-event") &&
    text.includes("type:`connect-app-host`") &&
    text.includes("networkOverrideFunc:"),
  /^app-initial-.*\.js$/,
);
replaceOnce(
  appInitialPath,
  "a.current??=Yfn({initialEntries:n,initialIndex:r,v5Compat:!0})",
  "a.current??=Yfn({initialEntries:n??[window.__ELECTRON_SHIM__.initialRoute],initialIndex:r,v5Compat:!0})",
  "initial memory route",
);
replaceOnce(
  appInitialPath,
  "l=iS.useCallback(e=>{i===!1?c(e):iS.startTransition(()=>c(e))},[i])",
  "l=iS.useCallback(e=>{window.__ELECTRON_SHIM__.onMemoryNavigationChanged(e),i===!1?c(e):iS.startTransition(()=>c(e))},[i])",
  "memory navigation notification",
);

replaceOnce(
  appInitialPath,
  "E0n=100,iT=ha(Q,!0),D0n=ha(Q,!0)",
  "E0n=100,iT=ha(Q,window.__ELECTRON_SHIM__.initialSidebarState),D0n=ha(Q,!0)",
  "initial sidebar open state",
);
replaceOnce(
  appInitialPath,
  "j0n=ha(Q,()=>new DBe(1))",
  "j0n=ha(Q,()=>new DBe(window.__ELECTRON_SHIM__.initialSidebarState))",
  "initial sidebar motion state",
);

replaceOnce(
  appInitialPath,
  "let i=r;iA(`toggleSidebar`,i);",
  "let i=r;window.__ELECTRON_SHIM__.closeSidebar=()=>{f0n(e,!1,{animate:t})};iA(`toggleSidebar`,i);",
  "electron shim closeSidebar",
);

replaceOnce(
  appInitialPath,
  'g=new g6a,_=c,v=new Ban(null,{attributes:{"aria-multiline":`true`,dir:`auto`,role:`textbox`,spellcheck:`true`},',
  'g=new g6a,_=c,codexWebPointerInput=!1,codexWebAttributes=()=>codexWebPointerInput?{"aria-multiline":`true`,dir:`auto`,role:`textbox`,spellcheck:`true`}:{"aria-multiline":`true`,dir:`auto`,role:`textbox`,spellcheck:`true`,inputmode:`none`},codexWebSetPointerInput=e=>{codexWebPointerInput!==e&&(codexWebPointerInput=e,v.isDestroyed||v.setProps({attributes:codexWebAttributes()}))},v=new Ban(null,{attributes:codexWebAttributes(),',
  "prompt editor pointer input mode attributes",
);
replaceOnce(
  appInitialPath,
  "handleDOMEvents:{keyup(e,t){",
  "handleDOMEvents:{mousedown(e,t){return codexWebSetPointerInput(!0),!1},touchstart(e,t){return codexWebSetPointerInput(!0),!1},blur(e,t){return codexWebSetPointerInput(!1),!1},keyup(e,t){",
  "prompt editor pointer input mode events",
);

replaceOnce(
  appInitialPath,
  "function gxa(e){return`${yxa}${vxa(e)}`}",
  "function gxa(e){return vxa(e)}",
  "local file media source path",
);

replaceOnce(
  appInitialPath,
  "dIu={networkConfig:{api:oIu,logEventUrl:UNu,sdkExceptionUrl:sIu,networkOverrideFunc:RFu}}",
  "dIu={overrideAdapter:window.__ELECTRON_SHIM__.overrideAdapter,networkConfig:{preventAllNetworkTraffic:!0,api:oIu,logEventUrl:UNu,sdkExceptionUrl:sIu,networkOverrideFunc:RFu}}",
  "Statsig override adapter",
);
replaceOnce(
  appInitialPath,
  "{state:u}=Xx(),d=XS()===ZS",
  "{state:u,search:codexWebSearch}=Xx(),d=XS()===ZS",
  "home prompt query parameter",
);
replaceOnce(
  appInitialPath,
  "x=u?.prefillPrompt??r.get(ON)",
  "x=u?.prefillPrompt??new URLSearchParams(codexWebSearch).get(`prompt`)??r.get(ON)",
  "home composer prompt",
);

const chatgptLocalThreadPath = findAssetFile(
  "ChatGPT local conversation thread",
  (text) =>
    text.includes("function pk({conversationId:e") &&
    text.includes("A2 as S") &&
    text.includes("Ce?.id==null||Ce.readAt!=null||xe(Ce.id)"),
  /^local-conversation-thread-.*\.js$/,
);
replaceOnce(
  chatgptLocalThreadPath,
  "A2 as S,",
  "A2 as S,A2 as codexHostedWindowTitleAtom,",
  "conversation title signal import",
);
replaceOnce(
  chatgptLocalThreadPath,
  "T=K(Hl,e),E=K(qr,e);K(on,null)",
  "T=K(Hl,e),E=K(qr,e),codexHostedWindowTitle=K(codexHostedWindowTitleAtom,e);K(on,null)",
  "conversation title signal read",
);
replaceOnce(
  chatgptLocalThreadPath,
  "(0,_k.useEffect)(()=>{Ce?.id==null||Ce.readAt!=null||xe(Ce.id)},[Ce?.id,Ce?.readAt,xe]);let Ee=co(),",
  "(0,_k.useEffect)(()=>{Ce?.id==null||Ce.readAt!=null||xe(Ce.id)},[Ce?.id,Ce?.readAt,xe]);(0,_k.useEffect)(()=>{let t=codexHostedWindowTitle?.trim();t&&(document.title=`${t} | Codex`)},[codexHostedWindowTitle]);let Ee=co(),",
  "browser document title sync",
);

const workerPath = path.join(buildRoot, "worker.js");
replaceOnce(
  workerPath,
  "IT({dsn:e.dsn,environment:e.buildFlavor,",
  "IT({enabled:!1,dsn:e.dsn,environment:e.buildFlavor,",
  "worker Sentry disabled",
);

const shellPath = findFile(
  "desktop shell Sentry",
  buildRoot,
  (text) =>
    text.includes("bundle`,`electron") &&
    text.includes("child-process-gone") &&
    text.includes("render-process-gone"),
);
replaceOnce(
  shellPath,
  "mB({dsn:xV.dsn,environment:xV.buildFlavor,",
  "mB({enabled:!1,dsn:xV.dsn,environment:xV.buildFlavor,",
  "desktop shell Sentry disabled",
);

replaceOnce(
  appInitialPath,
  "ejr({beforeSend:gcn,dsn:e.dsn,environment:cjr,",
  "ejr({enabled:!1,beforeSend:gcn,dsn:e.dsn,environment:cjr,",
  "webview Sentry disabled",
);

console.log(
  `ChatGPT Desktop webview patches applied for ${desktopAppVersion}.`,
);
