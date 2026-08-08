import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const sourcePath = new URL(
  "../src/browser/mobile-keyboard.ts",
  import.meta.url,
);
let moduleSequence = 0;

const regionShiftProperty = "--codex-keyboard-region-shift";

class FakeEventTarget {
  listeners = new Map();

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type, target = this) {
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === "function") {
        listener({ target, type });
      } else {
        listener.handleEvent({ target, type });
      }
    }
  }
}

class FakeStyle {
  mutations = [];
  values = new Map();

  getPropertyValue(name) {
    return this.values.get(name) ?? "";
  }

  removeProperty(name) {
    if (this.values.has(name)) {
      this.mutations.push({ name, type: "remove" });
    }
    this.values.delete(name);
  }

  setProperty(name, value) {
    this.mutations.push({ name, type: "set", value });
    this.values.set(name, value);
  }
}

class FakeElement extends FakeEventTarget {
  attributes = new Map();
  children = [];
  dataset = {};
  editable = false;
  matchingSelectors = new Set();
  parentElement = null;
  rect = { bottom: 40, top: 0 };
  scrollLeft = 0;
  scrollTop = 0;
  style = new FakeStyle();
  textContent = "";

  append(child) {
    child.parentElement = this;
    this.children.push(child);
  }

  closest(selector) {
    for (
      let candidate = this;
      candidate !== null;
      candidate = candidate.parentElement
    ) {
      if (candidate.matches(selector)) {
        return candidate;
      }
    }
    return null;
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  getBoundingClientRect() {
    let shift = 0;
    for (
      let candidate = this;
      candidate !== null;
      candidate = candidate.parentElement
    ) {
      shift += Number.parseFloat(
        candidate.style.getPropertyValue(regionShiftProperty) || "0",
      );
    }
    return {
      bottom: this.rect.bottom + shift,
      height: this.rect.bottom - this.rect.top,
      left: 0,
      right: 100,
      top: this.rect.top + shift,
      width: 100,
      x: 0,
      y: this.rect.top + shift,
      toJSON() {},
    };
  }

  matches(selector) {
    if (this.editable && selector.includes("textarea")) {
      return true;
    }
    return selector
      .split(",")
      .some((candidate) => this.matchingSelectors.has(candidate.trim()));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
}

class FakeInputElement extends FakeElement {
  disabled = false;
  readOnly = false;

  constructor() {
    super();
    this.editable = true;
  }
}

class FakeTextAreaElement extends FakeInputElement {}

class FakeDocument extends FakeEventTarget {
  activeElement = null;
  body = new FakeElement();
  documentElement = new FakeElement();
  head = new FakeElement();
  scrollingElement = this.documentElement;

  createElement() {
    return new FakeElement();
  }

  querySelector(selector) {
    if (selector !== "style[data-codex-mobile-keyboard]") {
      return null;
    }
    return (
      this.head.children.find(
        (child) => child.dataset.codexMobileKeyboard === "true",
      ) ?? null
    );
  }
}

class FakeClock {
  animationFrames = new Map();
  nextId = 1;
  now = 0;
  timers = new Map();

  cancelAnimationFrame = (id) => {
    this.animationFrames.delete(id);
  };

  clearTimeout = (id) => {
    this.timers.delete(id);
  };

  requestAnimationFrame = (callback) => {
    const id = this.nextId++;
    this.animationFrames.set(id, callback);
    return id;
  };

  setTimeout = (callback, delay = 0) => {
    const id = this.nextId++;
    this.timers.set(id, { callback, due: this.now + delay });
    return id;
  };

  advanceWithoutFrame(milliseconds) {
    this.now += milliseconds;
    this.runDueTimers();
  }

  runDueTimers() {
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.due <= this.now)
        .sort((left, right) => left[1].due - right[1].due)[0];
      if (due === undefined) {
        return;
      }
      const [id, timer] = due;
      this.timers.delete(id);
      timer.callback();
    }
  }

  runFrame(milliseconds = 16) {
    this.now += milliseconds;
    this.runDueTimers();
    const callbacks = [...this.animationFrames.values()];
    this.animationFrames.clear();
    for (const callback of callbacks) {
      callback(this.now);
    }
  }

  runFrames(count) {
    for (let index = 0; index < count; index += 1) {
      this.runFrame();
    }
  }
}

async function loadKeyboardModule() {
  const source = (await readFile(sourcePath, "utf8")).replace(
    /import\s*\{\s*hasTouchInputCapability,\s*MOBILE_SEARCH_INPUT_SELECTOR,\s*\}\s*from\s*"\.\/mobile-layout";/,
    `const hasTouchInputCapability = () => true;
const MOBILE_SEARCH_INPUT_SELECTOR =
  '[data-file-tree-search-input], [cmdk-input], [role="searchbox"], input[type="search"], input[data-search]';`,
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "mobile-keyboard.ts",
  });
  const encoded = Buffer.from(outputText).toString("base64");
  moduleSequence += 1;
  return import(`data:text/javascript;base64,${encoded}#${moduleSequence}`);
}

async function createHarness() {
  const clock = new FakeClock();
  const document = new FakeDocument();
  const viewport = new FakeEventTarget();
  Object.assign(viewport, {
    height: 768,
    offsetLeft: 0,
    offsetTop: 0,
    width: 1024,
  });
  const window = new FakeEventTarget();
  Object.assign(window, {
    cancelAnimationFrame: clock.cancelAnimationFrame,
    clearTimeout: clock.clearTimeout,
    innerHeight: 768,
    innerWidth: 1024,
    requestAnimationFrame: clock.requestAnimationFrame,
    setTimeout: clock.setTimeout,
    visualViewport: viewport,
  });
  const scrollCalls = [];
  window.scrollTo = (...coordinates) => scrollCalls.push(coordinates);

  Object.assign(globalThis, {
    document,
    Element: FakeElement,
    HTMLElement: FakeElement,
    HTMLInputElement: FakeInputElement,
    HTMLTextAreaElement: FakeTextAreaElement,
    window,
  });
  Object.defineProperty(globalThis, "performance", {
    configurable: true,
    value: { now: () => clock.now },
  });

  const { installMobileKeyboardViewport } = await loadKeyboardModule();
  installMobileKeyboardViewport();

  return {
    blur(input) {
      document.activeElement = null;
      window.emit("focusout", input);
    },
    clock,
    document,
    focus(input) {
      document.activeElement = input;
      window.emit("focusin", input);
    },
    input(matchingSelectors = [], rect = { bottom: 40, top: 0 }) {
      const input = new FakeInputElement();
      input.rect = rect;
      for (const selector of matchingSelectors) {
        input.matchingSelectors.add(selector);
      }
      return input;
    },
    region(selector, child) {
      const region = new FakeElement();
      region.matchingSelectors.add(selector);
      region.rect = { bottom: 768, top: 0 };
      region.append(child);
      return region;
    },
    root: document.documentElement,
    scrollCalls,
    viewport,
    viewportChanged(type = "resize") {
      viewport.emit(type);
    },
    window,
  };
}

const sessionAttribute = "data-codex-keyboard-session";
const keyboardAttribute = "data-codex-software-keyboard";
const activeSurfaceAttribute = "data-codex-active-keyboard-surface";
const activeRegionAttribute = "data-codex-keyboard-region";
const composerSelector = '[data-codex-keyboard-surface="composer"]';
const projectSearchSelector = '[data-codex-keyboard-surface="project-search"]';
const mainRegionSelector = "[data-app-shell-main-content-layout]";
const leftRegionSelector = "aside.app-shell-left-panel";
const rightRegionSelector = 'aside[data-app-shell-focus-area="right-panel"]';
const dialogRegionSelector = '[role="dialog"]';
const fileTreeSearchSelector = "[data-file-tree-search-input]";
const commandSearchSelector = "[cmdk-input]";
const textFileSearchSelector = "input[data-search]";

function shiftOf(region) {
  return region.style.getPropertyValue(regionShiftProperty);
}

function settle(harness, milliseconds = 240) {
  harness.clock.advanceWithoutFrame(milliseconds);
}

async function settleFocusTurn() {
  await Promise.resolve();
}

test("mobile keyboard viewport coordinator", async (suite) => {
  await suite.test(
    "does not move the focused composer during an opening resize storm",
    async () => {
      const harness = await createHarness();
      const composer = harness.input([composerSelector], {
        bottom: 740,
        top: 680,
      });
      const center = harness.region(mainRegionSelector, composer);
      const styleText = harness.document.head.children[0]?.textContent ?? "";

      harness.focus(composer);
      for (const [height, top] of [
        [700, 0],
        [610, 18],
        [520, 36],
        [450, 48],
      ]) {
        Object.assign(harness.viewport, { height, offsetTop: top });
        harness.viewportChanged();
        settle(harness, 100);
        assert.equal(shiftOf(center), "");
      }

      settle(harness, 139);
      assert.equal(shiftOf(center), "");
      settle(harness, 1);
      assert.equal(shiftOf(center), "-270px");
      assert.equal(center.getAttribute(activeRegionAttribute), "active");
      assert.equal(harness.root.getAttribute(keyboardAttribute), "true");
      assert.equal(harness.root.getAttribute(sessionAttribute), "true");
      assert.equal(center.style.mutations.length, 1);
      assert.match(styleText, /transition: none/);
      assert.doesNotMatch(styleText, /will-change|\bbody\b|#root/);
    },
  );

  await suite.test(
    "freezes one correction instead of following Visual Viewport pan noise",
    async () => {
      const harness = await createHarness();
      const composer = harness.input([composerSelector]);
      const center = harness.region(mainRegionSelector, composer);
      harness.focus(composer);
      harness.viewport.height = 450;
      harness.viewportChanged();
      settle(harness);

      assert.equal(shiftOf(center), "-318px");
      assert.equal(center.style.mutations.length, 1);

      for (const top of [24, 72, 100, 64]) {
        harness.viewport.offsetTop = top;
        harness.viewportChanged("scroll");
        settle(harness);
      }

      assert.equal(shiftOf(center), "-318px");
      assert.equal(center.style.mutations.length, 1);
      assert.equal(harness.clock.animationFrames.size, 0);
    },
  );

  await suite.test(
    "does not mistake keyboard accessory resizing for keyboard close",
    async () => {
      const harness = await createHarness();
      const composer = harness.input([composerSelector]);
      const center = harness.region(mainRegionSelector, composer);
      harness.focus(composer);
      harness.viewport.height = 450;
      harness.viewportChanged();
      settle(harness);

      harness.viewport.height = 540;
      harness.viewportChanged();
      settle(harness);

      assert.equal(harness.root.getAttribute(keyboardAttribute), "true");
      assert.equal(shiftOf(center), "-318px");
      assert.equal(center.style.mutations.length, 1);
    },
  );

  await suite.test(
    "clears a closed keyboard without writing document scroll state",
    async () => {
      const harness = await createHarness();
      const composer = harness.input([composerSelector]);
      const center = harness.region(mainRegionSelector, composer);
      harness.document.documentElement.scrollTop = 41;
      harness.document.body.scrollTop = 23;
      harness.focus(composer);
      harness.viewport.height = 450;
      harness.viewportChanged();
      settle(harness);

      for (const height of [520, 640, 768]) {
        harness.viewport.height = height;
        harness.viewportChanged();
        settle(harness, 100);
        assert.equal(shiftOf(center), "-318px");
      }
      settle(harness);

      assert.equal(shiftOf(center), "");
      assert.equal(center.getAttribute(activeRegionAttribute), null);
      assert.equal(harness.root.getAttribute(keyboardAttribute), "false");
      assert.equal(harness.root.getAttribute(sessionAttribute), "true");
      assert.deepEqual(harness.scrollCalls, []);
      assert.equal(harness.document.documentElement.scrollTop, 41);
      assert.equal(harness.document.body.scrollTop, 23);
    },
  );

  await suite.test(
    "keeps a close-reopen race in one stable open transaction",
    async () => {
      const harness = await createHarness();
      const composer = harness.input([composerSelector]);
      const center = harness.region(mainRegionSelector, composer);
      harness.focus(composer);
      harness.viewport.height = 450;
      harness.viewportChanged();
      settle(harness);

      harness.viewport.height = 768;
      harness.viewportChanged();
      settle(harness, 120);
      harness.viewport.height = 450;
      harness.viewportChanged();
      settle(harness);

      assert.equal(harness.root.getAttribute(keyboardAttribute), "true");
      assert.equal(shiftOf(center), "-318px");
      assert.equal(center.style.mutations.length, 1);
      assert.deepEqual(harness.scrollCalls, []);
    },
  );

  await suite.test(
    "rearms a still-focused composer after keyboard dismissal",
    async () => {
      const harness = await createHarness();
      const composer = harness.input([composerSelector]);
      const center = harness.region(mainRegionSelector, composer);
      harness.focus(composer);
      harness.viewport.height = 450;
      harness.viewportChanged();
      settle(harness);

      harness.viewport.height = 768;
      harness.viewportChanged();
      settle(harness);
      assert.equal(shiftOf(center), "");

      harness.viewport.height = 440;
      harness.viewportChanged();
      settle(harness);
      assert.equal(harness.root.getAttribute(keyboardAttribute), "true");
      assert.equal(shiftOf(center), "-328px");
      assert.equal(
        center.style.mutations.filter(({ type }) => type === "set").length,
        2,
      );
    },
  );

  await suite.test(
    "switches owners only after the new focus geometry settles",
    async () => {
      const harness = await createHarness();
      const composer = harness.input([composerSelector]);
      const center = harness.region(mainRegionSelector, composer);
      harness.focus(composer);
      harness.viewport.height = 450;
      harness.viewportChanged();
      settle(harness);

      const editor = harness.input([], { bottom: 650, top: 600 });
      const right = harness.region(rightRegionSelector, editor);
      harness.focus(editor);
      assert.equal(shiftOf(center), "-318px");
      assert.equal(shiftOf(right), "");

      settle(harness);
      assert.equal(center.getAttribute(activeRegionAttribute), null);
      assert.equal(shiftOf(center), "");
      assert.equal(shiftOf(right), "-200px");
      assert.equal(
        harness.root.getAttribute(activeSurfaceAttribute),
        "right-sidebar-editor",
      );
    },
  );

  await suite.test(
    "leaves top searches native and exposes only occluded regional editors",
    async () => {
      const fileHarness = await createHarness();
      const fileSearch = fileHarness.input([fileTreeSearchSelector], {
        bottom: 80,
        top: 40,
      });
      const left = fileHarness.region(leftRegionSelector, fileSearch);
      fileHarness.focus(fileSearch);
      fileHarness.viewport.height = 450;
      fileHarness.viewportChanged();
      settle(fileHarness);
      assert.equal(shiftOf(left), "");
      assert.equal(
        fileHarness.root.getAttribute(activeSurfaceAttribute),
        "file-tree-search",
      );

      const commandHarness = await createHarness();
      const commandSearch = commandHarness.input([commandSearchSelector]);
      commandHarness.focus(commandSearch);
      commandHarness.viewport.height = 450;
      commandHarness.viewportChanged();
      settle(commandHarness);
      assert.equal(
        commandHarness.root.getAttribute(activeSurfaceAttribute),
        "command-search",
      );
      assert.equal(commandSearch.getAttribute(activeRegionAttribute), null);

      const editorHarness = await createHarness();
      const editor = editorHarness.input([], { bottom: 520, top: 470 });
      const center = editorHarness.region(mainRegionSelector, editor);
      editorHarness.focus(editor);
      editorHarness.viewport.height = 450;
      editorHarness.viewportChanged();
      settle(editorHarness);
      assert.equal(shiftOf(center), "-70px");
      assert.equal(editor.getBoundingClientRect().bottom, 450);
    },
  );

  await suite.test(
    "moves the complete composer project picker above the settled keyboard",
    async () => {
      const harness = await createHarness();
      const projectSearch = harness.input([commandSearchSelector], {
        bottom: 550,
        top: 510,
      });
      const projectRoot = harness.region(projectSearchSelector, projectSearch);
      const popover = harness.region(dialogRegionSelector, projectRoot);
      popover.rect = { bottom: 760, top: 500 };

      harness.focus(projectSearch);
      harness.viewport.height = 450;
      harness.viewportChanged();
      settle(harness);

      assert.equal(
        harness.root.getAttribute(activeSurfaceAttribute),
        "project-search",
      );
      assert.equal(shiftOf(popover), "-310px");
      assert.equal(shiftOf(projectRoot), "");
      assert.equal(popover.getBoundingClientRect().bottom, 450);

      Object.assign(harness.viewport, { height: 430, offsetTop: 20 });
      harness.viewportChanged("scroll");
      settle(harness);
      assert.equal(shiftOf(popover), "-310px");
      assert.equal(popover.style.mutations.length, 1);

      Object.assign(harness.viewport, { height: 768, offsetTop: 0 });
      harness.viewportChanged();
      settle(harness);
      assert.equal(shiftOf(popover), "");
      assert.equal(popover.getAttribute(activeRegionAttribute), null);
    },
  );

  await suite.test(
    "retains the pre-focus baseline when WebKit resizes first",
    async () => {
      const harness = await createHarness();
      harness.viewport.height = 450;
      harness.viewportChanged();
      settle(harness);

      const composer = harness.input([composerSelector]);
      const center = harness.region(mainRegionSelector, composer);
      harness.focus(composer);
      settle(harness);

      assert.equal(harness.root.getAttribute(keyboardAttribute), "true");
      assert.equal(shiftOf(center), "-318px");
    },
  );

  await suite.test("does nothing for hardware-keyboard focus", async () => {
    const harness = await createHarness();
    const composer = harness.input([composerSelector]);
    const center = harness.region(mainRegionSelector, composer);
    harness.document.documentElement.scrollTop = 41;
    harness.document.body.scrollTop = 23;

    harness.focus(composer);
    settle(harness);
    assert.equal(shiftOf(center), "");
    assert.equal(harness.root.getAttribute(keyboardAttribute), "false");

    harness.blur(composer);
    await settleFocusTurn();
    assert.equal(harness.root.getAttribute(sessionAttribute), "false");
    assert.equal(harness.root.getAttribute(activeSurfaceAttribute), "none");
    assert.deepEqual(harness.scrollCalls, []);
    assert.equal(harness.document.documentElement.scrollTop, 41);
    assert.equal(harness.document.body.scrollTop, 23);
  });

  await suite.test(
    "clears the last owner after blur and stable close",
    async () => {
      const harness = await createHarness();
      const composer = harness.input([composerSelector]);
      const center = harness.region(mainRegionSelector, composer);
      harness.focus(composer);
      harness.viewport.height = 450;
      harness.viewportChanged();
      settle(harness);

      harness.blur(composer);
      harness.viewport.height = 768;
      harness.viewportChanged();
      await settleFocusTurn();
      settle(harness);

      assert.equal(harness.root.getAttribute(keyboardAttribute), "false");
      assert.equal(harness.root.getAttribute(sessionAttribute), "false");
      assert.equal(harness.root.getAttribute(activeSurfaceAttribute), "none");
      assert.equal(center.getAttribute(activeRegionAttribute), null);
      assert.equal(shiftOf(center), "");
      assert.deepEqual(harness.scrollCalls, []);
    },
  );

  await suite.test(
    "re-baselines rotation only after the open keyboard closes",
    async () => {
      const harness = await createHarness();
      const composer = harness.input([composerSelector]);
      const center = harness.region(mainRegionSelector, composer);
      harness.focus(composer);
      harness.viewport.height = 450;
      harness.viewportChanged();
      settle(harness);

      harness.window.innerWidth = 700;
      Object.assign(harness.viewport, { height: 400, width: 700 });
      center.rect = { bottom: 400, top: 0 };
      harness.window.emit("resize");
      settle(harness);
      assert.equal(shiftOf(center), "0px");

      harness.viewport.height = 650;
      harness.viewportChanged();
      settle(harness);
      assert.equal(harness.root.getAttribute(keyboardAttribute), "false");
      assert.equal(shiftOf(center), "");

      center.rect = { bottom: 650, top: 0 };
      harness.viewport.height = 520;
      harness.viewportChanged();
      settle(harness);
      assert.equal(harness.root.getAttribute(keyboardAttribute), "true");
      assert.equal(shiftOf(center), "-130px");
    },
  );

  await suite.test(
    "keeps prompt DOM attributes static and gates only mount autofocus",
    async () => {
      const patcher = await readFile(
        new URL("../scripts/patch-desktop-asar.mjs", import.meta.url),
        "utf8",
      );
      const shim = await readFile(
        new URL("../src/browser/shim.ts", import.meta.url),
        "utf8",
      );
      const coordinator = await readFile(sourcePath, "utf8");

      assert.match(patcher, /stable prompt editor keyboard surface attributes/);
      assert.match(patcher, /stable prompt editor DOM events/);
      assert.match(patcher, /project picker keyboard surface/);
      assert.match(patcher, /touch-safe composer mount focus/);
      assert.match(patcher, /shouldAutoFocusComposer/);
      assert.match(shim, /!hasTouchInputCapability\(\)/);
      assert.doesNotMatch(coordinator, /requestAnimationFrame|scrollTo/);
    },
  );
});
