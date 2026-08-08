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

function replaceOneOfOnce(filePath, candidates, label) {
  const text = readText(filePath);
  // Several supported source variants may intentionally converge on the same
  // patched contract. Count each distinct output once so a second patch pass
  // remains idempotent without weakening the exactly-one-output assertion.
  const patchedCount = [
    ...new Set(candidates.map(({ after }) => after)),
  ].reduce((count, after) => count + countOccurrences(text, after), 0);
  if (patchedCount === 1) {
    console.log(`Already patched ${label}`);
    return;
  }
  if (patchedCount !== 0) {
    throw new Error(
      `Expected at most one patched variant for ${label} in ${filePath}, found ${patchedCount}.`,
    );
  }

  const matches = candidates.flatMap(({ before, after }) =>
    Array(countOccurrences(text, before)).fill({ before, after }),
  );
  if (matches.length !== 1) {
    throw new Error(
      `Expected one supported variant for ${label} in ${filePath}, found ${matches.length}.`,
    );
  }

  writeText(filePath, text.replace(matches[0].before, matches[0].after));
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

const codexMicroServicePath = findFile(
  "Codex Micro service",
  buildRoot,
  (text) =>
    text.includes("HID topology watcher addon not found") &&
    text.includes("@worklouder/device-kit-oai") &&
    text.includes("CodexMicroService"),
);
// Official Desktop can load its Electron-specific HID watcher. The browser
// bridge hosts this service in plain Node, so use the project-owned node-hid
// build and the service's existing polling fallback on every host Node runtime.
replaceOnce(
  codexMicroServicePath,
  "process.platform===`linux`?",
  "(process.release.name===`node`||process.platform===`linux`)?",
  "Codex Micro host Node HID discovery",
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
// Touch context actions use explicit renderer-owned buttons. The upstream
// Radix trigger otherwise reserves a stationary scroll start for a delayed
// context menu, making vertical panning ambiguous.
replaceOneOfOnce(
  appInitialPath,
  [
    {
      before:
        "onPointerDown:r?e.onPointerDown:cg(e.onPointerDown,Kvt(e=>{u(),l.current=window.setTimeout(()=>d(e),700)}))",
      after:
        "onPointerDown:r?e.onPointerDown:cg(e.onPointerDown,Kvt(()=>{u()}))",
    },
    {
      before:
        "onPointerDown:r?e.onPointerDown:ug(e.onPointerDown,Wvt(e=>{u(),l.current=window.setTimeout(()=>d(e),700)}))",
      after:
        "onPointerDown:r?e.onPointerDown:ug(e.onPointerDown,Wvt(()=>{u()}))",
    },
  ],
  "context-menu touch long press disabled",
);
// Electron's native menu cannot render in a browser. Keep Desktop on that path,
// but make codex-web use the component's existing Radix branch on every input
// type so mouse and touch see the same renderer-owned menu and animation.
replaceOnce(
  appInitialPath,
  "d=!a&&window.electronBridge?.showContextMenu!=null",
  "d=!a&&window.electronBridge?.showContextMenu!=null&&!window.__ELECTRON_SHIM__",
  "browser renderer context-menu branch",
);
// The browser layout must close the real right-panel atom rather than locating
// a localized toolbar button by aria-label. Expose that renderer-owned action
// and the declarative open state used to isolate the closing drawer animation.
replaceOneOfOnce(
  appInitialPath,
  [
    {
      before:
        "function k3r({children:e,isRightPanelOpen:t,mainContentWidth:n,rightPanelDefaultWidth:r,rightPanelWidth:i,rightPanelWidthRatio:a,widthMode:o}){let s=Oo(Jw),",
      after:
        "function k3r({children:e,isRightPanelOpen:t,mainContentWidth:n,rightPanelDefaultWidth:r,rightPanelWidth:i,rightPanelWidthRatio:a,widthMode:o}){let s=Oo(Jw);window.__ELECTRON_SHIM__&&(window.__ELECTRON_SHIM__.closeRightPanel=()=>rT(s,!1));let ",
    },
    {
      before:
        "function D3r({children:e,isRightPanelOpen:t,mainContentWidth:n,rightPanelDefaultWidth:r,rightPanelWidth:i,rightPanelWidthRatio:a,widthMode:o}){let s=Ao(Kw),",
      after:
        "function D3r({children:e,isRightPanelOpen:t,mainContentWidth:n,rightPanelDefaultWidth:r,rightPanelWidth:i,rightPanelWidthRatio:a,widthMode:o}){let s=Ao(Kw);window.__ELECTRON_SHIM__&&(window.__ELECTRON_SHIM__.closeRightPanel=()=>tT(s,!1));let ",
    },
  ],
  "browser right-panel close bridge",
);
replaceOnce(
  appInitialPath,
  '"data-app-shell-focus-area":`right-panel`,className:',
  '"data-app-shell-focus-area":`right-panel`,"data-codex-panel-open":t,className:',
  "browser right-panel open state",
);
replaceOnce(
  appInitialPath,
  "style:{minWidth:v,width:v}",
  '"data-codex-right-panel-surface":!0,style:{minWidth:v,width:v}',
  "browser right-panel surface marker",
);
// Mark only the active Radix trigger. A renderer-owned inline button can then
// open that exact context-menu root without copying its items or callbacks.
replaceOnce(
  appInitialPath,
  "t[48]===P?e=t[49]:(e={onContextMenu:P},t[48]=P,t[49]=e)",
  't[48]===P?e=t[49]:(e={"data-codex-context-target":`true`,onContextMenu:P},t[48]=P,t[49]=e)',
  "browser context-menu trigger target",
);
// Mark the row and its content surface so the touch stylesheet can move the
// renderer-owned action rail into a natural trailing flex slot. Desktop keeps
// the upstream absolute hover rail; no status/loading node is relocated.
replaceOnce(
  appInitialPath,
  "className:`flex h-full w-full items-center text-sm leading-4`,children:[Rn,zn,Bn]",
  '"data-codex-row-content":!0,className:`flex h-full w-full items-center text-sm leading-4`,children:[Rn,zn,Bn]',
  "browser row content marker",
);
replaceOnce(
  appInitialPath,
  'className:Qt,"data-title-aligned-trailing-rail":gn,onClick:Bt',
  'className:Qt,"data-codex-row-layout":!0,"data-title-aligned-trailing-rail":gn,onClick:Bt',
  "browser row layout marker",
);
// App-shell tabs expose close, close-others, placement, and tab-specific
// commands only through their context menu. Add one renderer-owned inline
// touch entry to the existing tab component and open that exact Radix root.
replaceOnce(
  appInitialPath,
  "children:[Se,ze,Be]",
  'children:[Se,ze,(0,Ek.jsx)(`button`,{type:`button`,"aria-haspopup":`menu`,"aria-label":P.formatMessage({id:`codex.tabs.contextMenu.more`,defaultMessage:`Tab options`,description:`Opens the tab context menu from its inline touch action`}),className:`codex-mobile-tab-context-action`,onClick:e=>{e.stopPropagation(),window.__ELECTRON_SHIM__?.openContextMenuFromButton?.(e.currentTarget)},onPointerDown:CMr,children:(0,Ek.jsxs)(`svg`,{"aria-hidden":!0,className:`icon-xs`,viewBox:`0 0 21 21`,children:[(0,Ek.jsx)(`circle`,{cx:4.7,cy:10.5,r:1.5,fill:`currentColor`}),(0,Ek.jsx)(`circle`,{cx:10.2,cy:10.5,r:1.5,fill:`currentColor`}),(0,Ek.jsx)(`circle`,{cx:15.7,cy:10.5,r:1.5,fill:`currentColor`})]})}),Be]',
  "mobile right-panel tab context-menu action",
);
// The alternate app-shell tab implementation is selected by a renderer gate.
// Keep the same inline action in both branches so capability detection does not
// depend on remote experiment state.
replaceOnce(
  appInitialPath,
  "children:[re,he,ge]",
  'children:[re,he,(0,Pk.jsx)(`button`,{type:`button`,"aria-haspopup":`menu`,"aria-label":M.formatMessage({id:`codex.tabs.contextMenu.more`,defaultMessage:`Tab options`,description:`Opens the tab context menu from its inline touch action`}),className:`codex-mobile-tab-context-action`,onClick:e=>{e.stopPropagation(),window.__ELECTRON_SHIM__?.openContextMenuFromButton?.(e.currentTarget)},onPointerDown:KNr,children:(0,Pk.jsxs)(`svg`,{"aria-hidden":!0,className:`icon-xs`,viewBox:`0 0 21 21`,children:[(0,Pk.jsx)(`circle`,{cx:4.7,cy:10.5,r:1.5,fill:`currentColor`}),(0,Pk.jsx)(`circle`,{cx:10.2,cy:10.5,r:1.5,fill:`currentColor`}),(0,Pk.jsx)(`circle`,{cx:15.7,cy:10.5,r:1.5,fill:`currentColor`})]})}),ge]',
  "mobile alternate right-panel tab context-menu action",
);
// Sidebar thread rows already own a trailing action rail. Add one mobile-only
// entry to that rail and forward the completed click event through the existing
// action renderer so it can open the marked Radix trigger at the button.
replaceOneOfOnce(
  appInitialPath,
  [
    {
      before:
        '"aria-label":e.ariaLabel,onClick:t=>{t.stopPropagation(),e.onClick()},onPointerDown:Ezc',
      after:
        '"aria-label":e.ariaLabel,"aria-haspopup":e.ariaHasPopup,onClick:t=>{t.stopPropagation(),e.onClick(t)},onPointerDown:Ezc',
    },
    {
      before:
        '"aria-label":e.ariaLabel,onClick:t=>{t.stopPropagation(),e.onClick()},onPointerDown:zzc',
      after:
        '"aria-label":e.ariaLabel,"aria-haspopup":e.ariaHasPopup,onClick:t=>{t.stopPropagation(),e.onClick(t)},onPointerDown:zzc',
    },
  ],
  "renderer row-action click event",
);
replaceOneOfOnce(
  appInitialPath,
  [
    {
      before:
        "{archive:n,pinAction:r}=e,i=Ju();if(n==null&&r==null)return null;let a;",
      after: "{archive:n,pinAction:r}=e,i=Ju();let a;",
    },
    {
      before:
        "{archive:n,pinAction:r}=e,i=Zu();if(n==null&&r==null)return null;let a;",
      after: "{archive:n,pinAction:r}=e,i=Zu();let a;",
    },
  ],
  "mobile thread action rail availability",
);
replaceOneOfOnce(
  appInitialPath,
  [
    {
      before: "actions:[...a,...o],className:SLc",
      after:
        'actions:[...a,...o,{id:`thread-context-action`,ariaHasPopup:`menu`,ariaLabel:i.formatMessage({id:`codex.mobile.threadActions`,defaultMessage:`More options`,description:`Opens the thread context menu from its inline mobile action`}),buttonClassName:`codex-mobile-context-action`,icon:(0,b0.jsxs)(`svg`,{"aria-hidden":!0,className:`icon-xs`,viewBox:`0 0 21 21`,children:[(0,b0.jsx)(`circle`,{cx:4.7,cy:10.5,r:1.5,fill:`currentColor`}),(0,b0.jsx)(`circle`,{cx:10.2,cy:10.5,r:1.5,fill:`currentColor`}),(0,b0.jsx)(`circle`,{cx:15.7,cy:10.5,r:1.5,fill:`currentColor`})]}),onClick:e=>window.__ELECTRON_SHIM__?.openContextMenuFromButton?.(e.currentTarget)}],className:SLc',
    },
    {
      before: "actions:[...a,...o],className:FLc",
      after:
        'actions:[...a,...o,{id:`thread-context-action`,ariaHasPopup:`menu`,ariaLabel:i.formatMessage({id:`codex.mobile.threadActions`,defaultMessage:`More options`,description:`Opens the thread context menu from its inline mobile action`}),buttonClassName:`codex-mobile-context-action`,icon:(0,b0.jsxs)(`svg`,{"aria-hidden":!0,className:`icon-xs`,viewBox:`0 0 21 21`,children:[(0,b0.jsx)(`circle`,{cx:4.7,cy:10.5,r:1.5,fill:`currentColor`}),(0,b0.jsx)(`circle`,{cx:10.2,cy:10.5,r:1.5,fill:`currentColor`}),(0,b0.jsx)(`circle`,{cx:15.7,cy:10.5,r:1.5,fill:`currentColor`})]}),onClick:e=>window.__ELECTRON_SHIM__?.openContextMenuFromButton?.(e.currentTarget)}],className:FLc',
    },
  ],
  "mobile thread context-menu action",
);
// The file tree has its own renderer-native row action lane and menu button.
// Enable that button directly on mobile, while retaining mouse-only dragging
// and the existing right-click configuration on Desktop.
replaceOnce(
  appInitialPath,
  "Le=Ie===`both`||Ie===`button`,Re=e?.contextMenu?.buttonVisibility??`when-needed`,ze=Ie===`both`||Ie===`right-click`",
  "Le=Ie===`both`||Ie===`button`||document.documentElement.getAttribute(`data-codex-mobile-ui`)===`true`,Re=document.documentElement.getAttribute(`data-codex-mobile-ui`)===`true`?`always`:e?.contextMenu?.buttonVisibility??`when-needed`,ze=Ie===`both`||Ie===`right-click`",
  "file-tree mobile native menu button",
);
replaceOnce(
  appInitialPath,
  "onTouchStart:u&&!F?e=>{m(e,t,P)}:void 0",
  "onTouchStart:void 0",
  "file-tree touch drag disabled",
);
// dnd-kit activates its PointerSensor on pointerdown and then installs a
// non-passive move listener that prevents native scrolling. Dragging is
// intentionally mouse-only in the browser surface: reject touch, pen, and
// unidentified pointer types while preserving their original events for row
// clicks and WebKit scrolling.
replaceOneOfOnce(
  appInitialPath,
  [
    {
      before: "return!n.isPrimary||n.button!==0?!1:(r?.({event:n}),!0)",
      after:
        "return n.pointerType!==`mouse`||!n.isPrimary||n.button!==0?!1:(r?.({event:n}),!0)",
    },
    {
      before:
        "return n.pointerType===`touch`||!n.isPrimary||n.button!==0?!1:(r?.({event:n}),!0)",
      after:
        "return n.pointerType!==`mouse`||!n.isPrimary||n.button!==0?!1:(r?.({event:n}),!0)",
    },
  ],
  "dnd-kit non-mouse dragging disabled",
);
// The bundled Shiki JavaScript regex engine assumes ES2025 inline modifier
// groups are available, but current Safari/WebKit releases can reject the
// generated `(?i:...)` forms. Compile TextMate grammars to the engine's ES2018
// compatibility target so file rendering works across supported browsers.
replaceOneOfOnce(
  appInitialPath,
  [
    {
      before:
        "function VWi(e={}){let t=Object.assign({target:`auto`,cache:new Map},e)",
      after:
        "function VWi(e={}){let t=Object.assign({target:`ES2018`,cache:new Map},e)",
    },
    {
      before:
        "function WWi(e={}){let t=Object.assign({target:`auto`,cache:new Map},e)",
      after:
        "function WWi(e={}){let t=Object.assign({target:`ES2018`,cache:new Map},e)",
    },
  ],
  "syntax highlighter Safari regex compatibility",
);
// The Windows Appx and macOS ZIP use different minified identifiers even at
// the same ASAR version. Keep both verified forms explicit so either known
// build patches successfully while any third contract still fails closed.
replaceOneOfOnce(
  appInitialPath,
  [
    {
      before: "a.current??=Yfn({initialEntries:n,initialIndex:r,v5Compat:!0})",
      after:
        "a.current??=Yfn({initialEntries:n??[window.__ELECTRON_SHIM__.initialRoute],initialIndex:r,v5Compat:!0})",
    },
    {
      before: "a.current??=Zfn({initialEntries:n,initialIndex:r,v5Compat:!0})",
      after:
        "a.current??=Zfn({initialEntries:n??[window.__ELECTRON_SHIM__.initialRoute],initialIndex:r,v5Compat:!0})",
    },
  ],
  "initial memory route",
);
replaceOneOfOnce(
  appInitialPath,
  [
    {
      before:
        "l=iS.useCallback(e=>{i===!1?c(e):iS.startTransition(()=>c(e))},[i])",
      after:
        "l=iS.useCallback(e=>{window.__ELECTRON_SHIM__.onMemoryNavigationChanged(e),i===!1?c(e):iS.startTransition(()=>c(e))},[i])",
    },
    {
      before:
        "l=nS.useCallback(e=>{i===!1?c(e):nS.startTransition(()=>c(e))},[i])",
      after:
        "l=nS.useCallback(e=>{window.__ELECTRON_SHIM__.onMemoryNavigationChanged(e),i===!1?c(e):nS.startTransition(()=>c(e))},[i])",
    },
  ],
  "memory navigation notification",
);

replaceOneOfOnce(
  appInitialPath,
  [
    {
      before: "E0n=100,iT=ha(Q,!0),D0n=ha(Q,!0)",
      after:
        "E0n=100,iT=ha(Q,window.__ELECTRON_SHIM__.initialSidebarState),D0n=ha(Q,!0)",
    },
    {
      before: "O0n=100,nT=_a(Q,!0),k0n=_a(Q,!0)",
      after:
        "O0n=100,nT=_a(Q,window.__ELECTRON_SHIM__.initialSidebarState),k0n=_a(Q,!0)",
    },
  ],
  "initial sidebar open state",
);
replaceOneOfOnce(
  appInitialPath,
  [
    {
      before: "j0n=ha(Q,()=>new DBe(1))",
      after:
        "j0n=ha(Q,()=>new DBe(window.__ELECTRON_SHIM__.initialSidebarState))",
    },
    {
      before: "N0n=_a(Q,()=>new TBe(1))",
      after:
        "N0n=_a(Q,()=>new TBe(window.__ELECTRON_SHIM__.initialSidebarState))",
    },
  ],
  "initial sidebar motion state",
);

replaceOneOfOnce(
  appInitialPath,
  [
    {
      before: "let i=r;iA(`toggleSidebar`,i);",
      after:
        "let i=r;window.__ELECTRON_SHIM__.closeSidebar=()=>{f0n(e,!1,{animate:t})};iA(`toggleSidebar`,i);",
    },
    {
      before: "let i=r;oA(`toggleSidebar`,i);",
      after:
        "let i=r;window.__ELECTRON_SHIM__.closeSidebar=()=>{m0n(e,!1,{animate:t})};oA(`toggleSidebar`,i);",
    },
  ],
  "electron shim closeSidebar",
);

replaceOneOfOnce(
  appInitialPath,
  [
    {
      before:
        'g=new g6a,_=c,v=new Ban(null,{attributes:{"aria-multiline":`true`,dir:`auto`,role:`textbox`,spellcheck:`true`},',
      after:
        'g=new g6a,_=c,codexWebPointerInput=!1,codexWebAttributes=()=>codexWebPointerInput?{"aria-multiline":`true`,dir:`auto`,role:`textbox`,spellcheck:`true`}:{"aria-multiline":`true`,dir:`auto`,role:`textbox`,spellcheck:`true`,inputmode:`none`},codexWebSetPointerInput=e=>{codexWebPointerInput!==e&&(codexWebPointerInput=e,v.isDestroyed||v.setProps({attributes:codexWebAttributes()}))},v=new Ban(null,{attributes:codexWebAttributes(),',
    },
    {
      before:
        'g=new S6a,_=c,v=new Ban(null,{attributes:{"aria-multiline":`true`,dir:`auto`,role:`textbox`,spellcheck:`true`},',
      after:
        'g=new S6a,_=c,codexWebPointerInput=!1,codexWebAttributes=()=>codexWebPointerInput?{"aria-multiline":`true`,dir:`auto`,role:`textbox`,spellcheck:`true`}:{"aria-multiline":`true`,dir:`auto`,role:`textbox`,spellcheck:`true`,inputmode:`none`},codexWebSetPointerInput=e=>{codexWebPointerInput!==e&&(codexWebPointerInput=e,v.isDestroyed||v.setProps({attributes:codexWebAttributes()}))},v=new Ban(null,{attributes:codexWebAttributes(),',
    },
  ],
  "prompt editor pointer input mode attributes",
);
replaceOnce(
  appInitialPath,
  "handleDOMEvents:{keyup(e,t){",
  "handleDOMEvents:{mousedown(e,t){return codexWebSetPointerInput(!0),!1},touchstart(e,t){return codexWebSetPointerInput(!0),!1},blur(e,t){return codexWebSetPointerInput(!1),!1},keyup(e,t){",
  "prompt editor pointer input mode events",
);

replaceOneOfOnce(
  appInitialPath,
  [
    {
      before: "function gxa(e){return`${yxa}${vxa(e)}`}",
      after: "function gxa(e){return vxa(e)}",
    },
    {
      before: "function yxa(e){return`${Sxa}${xxa(e)}`}",
      after: "function yxa(e){return xxa(e)}",
    },
  ],
  "local file media source path",
);

replaceOneOfOnce(
  appInitialPath,
  [
    {
      before:
        "dIu={networkConfig:{api:oIu,logEventUrl:UNu,sdkExceptionUrl:sIu,networkOverrideFunc:RFu}}",
      after:
        "dIu={overrideAdapter:window.__ELECTRON_SHIM__.overrideAdapter,networkConfig:{preventAllNetworkTraffic:!0,api:oIu,logEventUrl:UNu,sdkExceptionUrl:sIu,networkOverrideFunc:RFu}}",
    },
    {
      before:
        "kIu={networkConfig:{api:wIu,logEventUrl:oPu,sdkExceptionUrl:TIu,networkOverrideFunc:tIu}}",
      after:
        "kIu={overrideAdapter:window.__ELECTRON_SHIM__.overrideAdapter,networkConfig:{preventAllNetworkTraffic:!0,api:wIu,logEventUrl:oPu,sdkExceptionUrl:TIu,networkOverrideFunc:tIu}}",
    },
  ],
  "Statsig override adapter",
);
replaceOneOfOnce(
  appInitialPath,
  [
    {
      before: "{state:u}=Xx(),d=XS()===ZS",
      after: "{state:u,search:codexWebSearch}=Xx(),d=XS()===ZS",
    },
    {
      before: "{state:u}=Jx(),d=YS()===XS",
      after: "{state:u,search:codexWebSearch}=Jx(),d=YS()===XS",
    },
  ],
  "home prompt query parameter",
);
replaceOneOfOnce(
  appInitialPath,
  [
    {
      before: "x=u?.prefillPrompt??r.get(ON)",
      after:
        "x=u?.prefillPrompt??new URLSearchParams(codexWebSearch).get(`prompt`)??r.get(ON)",
    },
    {
      before: "x=u?.prefillPrompt??r.get(kN)",
      after:
        "x=u?.prefillPrompt??new URLSearchParams(codexWebSearch).get(`prompt`)??r.get(kN)",
    },
  ],
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
