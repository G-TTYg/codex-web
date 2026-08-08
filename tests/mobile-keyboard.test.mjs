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
  values = new Map();

  getPropertyValue(name) {
    return this.values.get(name) ?? "";
  }

  removeProperty(name) {
    this.values.delete(name);
  }

  setProperty(name, value) {
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

test("mobile keyboard viewport coordinator", async (suite) => {
  await suite.test("leaves top command search on native geometry", async () => {
    const harness = await createHarness();
    const input = harness.input([commandSearchSelector]);
    const styleText = harness.document.head.children[0]?.textContent ?? "";

    harness.focus(input);
    Object.assign(harness.viewport, { height: 450, offsetTop: 32 });
    harness.viewportChanged();

    assert.equal(harness.root.getAttribute(sessionAttribute), "true");
    assert.equal(
      harness.root.getAttribute(activeSurfaceAttribute),
      "command-search",
    );
    assert.equal(input.getAttribute(activeRegionAttribute), null);
    assert.equal(harness.root.style.values.size, 0);
    assert.equal(harness.document.body.style.values.size, 0);
    assert.match(styleText, /data-codex-keyboard-region/);
    assert.doesNotMatch(styleText, /\bbody\b|#root/);
  });

  await suite.test(
    "samples WebKit animation and lifts only the center region",
    async () => {
      const harness = await createHarness();
      const composer = harness.input([composerSelector], {
        bottom: 740,
        top: 680,
      });
      const center = harness.region(mainRegionSelector, composer);
      const left = new FakeElement();
      const right = new FakeElement();

      harness.focus(composer);
      Object.assign(harness.viewport, { height: 460, offsetTop: 48 });
      harness.clock.runFrame();

      assert.equal(shiftOf(center), "-260px");
      assert.equal(center.getAttribute(activeRegionAttribute), "active");
      assert.equal(left.getAttribute(activeRegionAttribute), null);
      assert.equal(right.getAttribute(activeRegionAttribute), null);
      assert.equal(harness.root.style.values.size, 0);
      assert.equal(harness.document.body.style.values.size, 0);
      assert.equal(harness.root.getAttribute(keyboardAttribute), "true");
    },
  );

  await suite.test(
    "aligns the center region bottom with the software keyboard",
    async () => {
      const harness = await createHarness();
      const composer = harness.input([composerSelector]);
      const center = harness.region(mainRegionSelector, composer);
      harness.focus(composer);

      harness.viewport.height = 600;
      harness.viewportChanged();
      assert.equal(shiftOf(center), "-168px");

      harness.viewport.height = 450;
      harness.viewportChanged();
      assert.equal(shiftOf(center), "-318px");
      assert.equal(768 + Number.parseFloat(shiftOf(center)), 450);
    },
  );

  await suite.test(
    "does not double-apply WebKit Visual Viewport panning",
    async () => {
      const harness = await createHarness();
      const composer = harness.input([composerSelector]);
      const center = harness.region(mainRegionSelector, composer);
      harness.focus(composer);
      Object.assign(harness.viewport, { height: 450, offsetTop: 100 });
      harness.viewportChanged("scroll");

      assert.equal(shiftOf(center), "-218px");
      assert.equal(
        768 + Number.parseFloat(shiftOf(center)),
        harness.viewport.offsetTop + harness.viewport.height,
      );
    },
  );

  await suite.test(
    "keeps file-tree and visible text-file searches stationary",
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
      assert.equal(
        fileHarness.root.getAttribute(activeSurfaceAttribute),
        "file-tree-search",
      );
      assert.equal(left.getAttribute(activeRegionAttribute), null);
      assert.equal(shiftOf(left), "");

      const textHarness = await createHarness();
      const textSearch = textHarness.input([textFileSearchSelector], {
        bottom: 90,
        top: 50,
      });
      const center = textHarness.region(mainRegionSelector, textSearch);
      textHarness.focus(textSearch);
      textHarness.viewport.height = 450;
      textHarness.viewportChanged();
      assert.equal(
        textHarness.root.getAttribute(activeSurfaceAttribute),
        "text-file-search",
      );
      assert.equal(shiftOf(center), "0px");
    },
  );

  await suite.test(
    "moves a middle editor only enough to reveal that input",
    async () => {
      const harness = await createHarness();
      const input = harness.input([], { bottom: 520, top: 470 });
      const center = harness.region(mainRegionSelector, input);
      harness.focus(input);
      harness.viewport.height = 450;
      harness.viewportChanged();

      assert.equal(
        harness.root.getAttribute(activeSurfaceAttribute),
        "main-editor",
      );
      assert.equal(shiftOf(center), "-70px");
      assert.equal(input.getBoundingClientRect().bottom, 450);
    },
  );

  await suite.test(
    "moves only the dialog or sidebar that owns an occluded editor",
    async () => {
      const cases = [
        [dialogRegionSelector, "dialog-editor"],
        [leftRegionSelector, "left-sidebar-editor"],
        [rightRegionSelector, "right-sidebar-editor"],
      ];
      for (const [selector, expectedSurface] of cases) {
        const harness = await createHarness();
        const input = harness.input([], { bottom: 650, top: 600 });
        const owner = harness.region(selector, input);
        Object.assign(harness.viewport, { height: 500, offsetTop: 24 });
        harness.focus(input);

        assert.equal(
          harness.root.getAttribute(activeSurfaceAttribute),
          expectedSurface,
        );
        assert.equal(shiftOf(owner), "-126px");
        assert.equal(input.getBoundingClientRect().bottom, 524);
      }
    },
  );

  await suite.test(
    "switches semantic regions without retaining the previous shift",
    async () => {
      const harness = await createHarness();
      harness.viewport.height = 450;
      const commandSearch = harness.input([commandSearchSelector]);
      harness.focus(commandSearch);

      const composer = harness.input([composerSelector]);
      const center = harness.region(mainRegionSelector, composer);
      harness.focus(composer);
      assert.equal(shiftOf(center), "-318px");

      const fileSearch = harness.input([fileTreeSearchSelector]);
      const left = harness.region(leftRegionSelector, fileSearch);
      harness.focus(fileSearch);
      assert.equal(center.getAttribute(activeRegionAttribute), null);
      assert.equal(shiftOf(center), "");
      assert.equal(left.getAttribute(activeRegionAttribute), null);
      assert.equal(
        harness.root.getAttribute(activeSurfaceAttribute),
        "file-tree-search",
      );
    },
  );

  await suite.test("does not normalize a hardware-keyboard focus", async () => {
    const harness = await createHarness();
    const input = harness.input([composerSelector]);
    const center = harness.region(mainRegionSelector, input);
    harness.document.documentElement.scrollTop = 41;
    harness.document.body.scrollTop = 23;

    harness.focus(input);
    assert.equal(shiftOf(center), "0px");
    harness.blur(input);
    harness.clock.runFrame();

    assert.equal(harness.root.getAttribute(sessionAttribute), "false");
    assert.equal(harness.root.getAttribute(activeSurfaceAttribute), "none");
    assert.equal(center.getAttribute(activeRegionAttribute), null);
    assert.deepEqual(harness.scrollCalls, []);
    assert.equal(harness.document.documentElement.scrollTop, 41);
    assert.equal(harness.document.body.scrollTop, 23);
  });

  await suite.test(
    "invalidates queued recovery when focus changes region",
    async () => {
      const harness = await createHarness();
      const composer = harness.input([composerSelector]);
      harness.region(mainRegionSelector, composer);
      harness.focus(composer);
      harness.viewport.height = 450;
      harness.viewportChanged();
      harness.viewport.height = 768;
      harness.viewportChanged();

      harness.clock.advanceWithoutFrame(160);
      harness.viewport.height = 450;
      const second = harness.input([], { bottom: 650, top: 600 });
      const right = harness.region(rightRegionSelector, second);
      harness.focus(second);
      harness.clock.runFrames(3);

      assert.deepEqual(harness.scrollCalls, []);
      assert.equal(harness.root.getAttribute(sessionAttribute), "true");
      assert.equal(harness.root.getAttribute(keyboardAttribute), "true");
      assert.equal(
        harness.root.getAttribute(activeSurfaceAttribute),
        "right-sidebar-editor",
      );
      assert.equal(shiftOf(right), "-200px");
    },
  );

  await suite.test(
    "finishes close recovery while frame sampling remains active",
    async () => {
      const harness = await createHarness();
      const input = harness.input([composerSelector]);
      const center = harness.region(mainRegionSelector, input);
      harness.focus(input);
      harness.viewport.height = 450;
      harness.viewportChanged();
      harness.viewport.height = 768;
      harness.viewportChanged();
      harness.clock.runFrames(20);

      assert.deepEqual(harness.scrollCalls, [[0, 0]]);
      assert.equal(harness.root.getAttribute(keyboardAttribute), "false");
      assert.equal(harness.root.getAttribute(sessionAttribute), "true");
      assert.equal(shiftOf(center), "0px");

      harness.viewport.height = 440;
      harness.viewportChanged();
      assert.equal(harness.root.getAttribute(keyboardAttribute), "true");
      assert.equal(shiftOf(center), "-328px");
    },
  );

  await suite.test(
    "clears the region only after blur and keyboard close",
    async () => {
      const harness = await createHarness();
      const input = harness.input([composerSelector]);
      const center = harness.region(mainRegionSelector, input);
      harness.focus(input);
      harness.viewport.height = 450;
      harness.viewportChanged();
      harness.blur(input);
      harness.viewport.height = 768;
      harness.viewportChanged();
      harness.clock.runFrames(20);

      assert.deepEqual(harness.scrollCalls, [[0, 0]]);
      assert.equal(harness.root.getAttribute(keyboardAttribute), "false");
      assert.equal(harness.root.getAttribute(sessionAttribute), "false");
      assert.equal(center.getAttribute(activeRegionAttribute), null);
      assert.equal(shiftOf(center), "");
    },
  );

  await suite.test(
    "re-baselines rotation and Split View width changes",
    async () => {
      const harness = await createHarness();
      const first = harness.input([composerSelector]);
      const center = harness.region(mainRegionSelector, first);
      harness.focus(first);
      harness.viewport.height = 450;
      harness.viewportChanged();

      harness.window.innerWidth = 700;
      Object.assign(harness.viewport, { height: 400, width: 700 });
      center.rect = { bottom: 400, top: 0 };
      harness.window.emit("resize");
      assert.equal(shiftOf(center), "0px");
      harness.viewport.height = 650;
      harness.viewportChanged();
      harness.clock.runFrames(20);
      assert.deepEqual(harness.scrollCalls, [[0, 0]]);

      harness.blur(first);
      harness.clock.runFrame();
      assert.equal(harness.root.getAttribute(sessionAttribute), "false");

      const second = harness.input([composerSelector]);
      const nextCenter = harness.region(mainRegionSelector, second);
      nextCenter.rect = { bottom: 650, top: 0 };
      harness.focus(second);
      harness.viewport.height = 520;
      harness.viewportChanged();
      assert.equal(harness.root.getAttribute(keyboardAttribute), "true");
      assert.equal(shiftOf(nextCenter), "-130px");
    },
  );
});
