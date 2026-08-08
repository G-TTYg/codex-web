import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const sourcePath = new URL(
  "../src/browser/mobile-keyboard.ts",
  import.meta.url,
);
let moduleSequence = 0;

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
  scrollLeft = 0;
  scrollTop = 0;
  style = new FakeStyle();
  textContent = "";

  append(child) {
    this.children.push(child);
  }

  closest() {
    return this.editable ? this : null;
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
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
    'import { hasTouchInputCapability } from "./mobile-layout";',
    "const hasTouchInputCapability = () => true;",
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
    input: () => new FakeInputElement(),
    root: document.documentElement,
    scrollCalls,
    viewport,
    viewportChanged(type = "resize") {
      viewport.emit(type);
    },
    window,
  };
}

const lockAttribute = "data-codex-visual-viewport-lock";
const keyboardAttribute = "data-codex-software-keyboard";
const heightProperty = "--codex-keyboard-shell-height";
const leftProperty = "--codex-keyboard-shell-left";
const topProperty = "--codex-keyboard-shell-top";
const widthProperty = "--codex-keyboard-shell-width";

test("mobile keyboard viewport coordinator", async (suite) => {
  await suite.test(
    "locks on focus and follows sub-threshold geometry",
    async () => {
      const harness = await createHarness();
      const input = harness.input();

      harness.focus(input);
      assert.equal(harness.root.getAttribute(lockAttribute), "true");
      assert.equal(
        harness.root.style.getPropertyValue(heightProperty),
        "768px",
      );

      Object.assign(harness.viewport, {
        height: 736,
        offsetLeft: 3,
        offsetTop: 12,
        width: 1000,
      });
      harness.viewportChanged();

      assert.equal(harness.root.getAttribute(lockAttribute), "true");
      assert.notEqual(harness.root.getAttribute(keyboardAttribute), "true");
      assert.equal(
        harness.root.style.getPropertyValue(heightProperty),
        "768px",
      );
      assert.equal(harness.root.style.getPropertyValue(leftProperty), "3px");
      assert.equal(harness.root.style.getPropertyValue(topProperty), "-20px");
      assert.equal(
        harness.root.style.getPropertyValue(widthProperty),
        "1000px",
      );
    },
  );

  await suite.test(
    "samples WebKit animation when events are absent",
    async () => {
      const harness = await createHarness();
      harness.focus(harness.input());

      Object.assign(harness.viewport, { height: 460, offsetTop: 48 });
      harness.clock.runFrame();

      assert.equal(
        harness.root.style.getPropertyValue(heightProperty),
        "768px",
      );
      assert.equal(harness.root.style.getPropertyValue(topProperty), "-260px");
      assert.equal(harness.root.getAttribute(keyboardAttribute), "true");
    },
  );

  await suite.test(
    "moves the whole shell upward and aligns its bottom with the keyboard",
    async () => {
      const harness = await createHarness();
      harness.focus(harness.input());

      harness.viewport.height = 600;
      harness.viewportChanged();
      assert.equal(
        harness.root.style.getPropertyValue(heightProperty),
        "768px",
      );
      assert.equal(harness.root.style.getPropertyValue(topProperty), "-168px");

      harness.viewport.height = 450;
      harness.viewportChanged();
      const shellHeight = Number.parseFloat(
        harness.root.style.getPropertyValue(heightProperty),
      );
      const shellTop = Number.parseFloat(
        harness.root.style.getPropertyValue(topProperty),
      );
      assert.equal(shellTop, -318);
      assert.equal(shellTop + shellHeight, 450);
    },
  );

  await suite.test(
    "does not double-apply WebKit's Visual Viewport pan",
    async () => {
      const harness = await createHarness();
      harness.focus(harness.input());
      Object.assign(harness.viewport, { height: 450, offsetTop: 100 });
      harness.viewportChanged("scroll");

      const shellHeight = Number.parseFloat(
        harness.root.style.getPropertyValue(heightProperty),
      );
      const shellTop = Number.parseFloat(
        harness.root.style.getPropertyValue(topProperty),
      );
      assert.equal(shellTop, -218);
      assert.equal(
        shellTop + shellHeight,
        harness.viewport.offsetTop + harness.viewport.height,
      );
      assert.equal(harness.root.getAttribute(keyboardAttribute), "true");
    },
  );

  await suite.test("does not normalize a hardware-keyboard focus", async () => {
    const harness = await createHarness();
    const input = harness.input();
    harness.document.documentElement.scrollTop = 41;
    harness.document.body.scrollTop = 23;

    harness.focus(input);
    assert.equal(harness.root.style.getPropertyValue(heightProperty), "768px");
    assert.equal(harness.root.style.getPropertyValue(topProperty), "0px");
    harness.blur(input);
    harness.clock.runFrame();

    assert.equal(harness.root.getAttribute(lockAttribute), "false");
    assert.equal(harness.root.style.getPropertyValue(heightProperty), "");
    assert.deepEqual(harness.scrollCalls, []);
    assert.equal(harness.document.documentElement.scrollTop, 41);
    assert.equal(harness.document.body.scrollTop, 23);
  });

  await suite.test(
    "invalidates queued recovery when focus changes",
    async () => {
      const harness = await createHarness();
      const first = harness.input();
      const second = harness.input();
      harness.focus(first);
      harness.viewport.height = 450;
      harness.viewportChanged();
      harness.viewport.height = 768;
      harness.viewportChanged();

      harness.clock.advanceWithoutFrame(160);
      harness.viewport.height = 450;
      harness.focus(second);
      harness.clock.runFrames(3);

      assert.deepEqual(harness.scrollCalls, []);
      assert.equal(harness.root.getAttribute(lockAttribute), "true");
      assert.equal(harness.root.getAttribute(keyboardAttribute), "true");
      assert.equal(
        harness.root.style.getPropertyValue(heightProperty),
        "768px",
      );
      assert.equal(harness.root.style.getPropertyValue(topProperty), "-318px");
    },
  );

  await suite.test(
    "finishes close recovery while frame sampling remains active",
    async () => {
      const harness = await createHarness();
      const input = harness.input();
      harness.focus(input);
      harness.viewport.height = 450;
      harness.viewportChanged();
      harness.viewport.height = 768;
      harness.viewportChanged();

      // The sampler runs for 1200ms. Recovery must not be postponed by each
      // sampled frame; it should finish after its 160ms settle delay.
      harness.clock.runFrames(20);

      assert.deepEqual(harness.scrollCalls, [[0, 0]]);
      assert.equal(harness.root.getAttribute(keyboardAttribute), "false");
      assert.equal(harness.root.getAttribute(lockAttribute), "true");
      assert.equal(
        harness.root.style.getPropertyValue(heightProperty),
        "768px",
      );
      assert.equal(harness.root.style.getPropertyValue(topProperty), "0px");

      harness.viewport.height = 440;
      harness.viewportChanged();
      assert.equal(harness.root.getAttribute(keyboardAttribute), "true");
      assert.equal(
        harness.root.style.getPropertyValue(heightProperty),
        "768px",
      );
      assert.equal(harness.root.style.getPropertyValue(topProperty), "-328px");
    },
  );

  await suite.test("unlocks only after blur and keyboard close", async () => {
    const harness = await createHarness();
    const input = harness.input();
    harness.focus(input);
    harness.viewport.height = 450;
    harness.viewportChanged();
    harness.blur(input);
    harness.viewport.height = 768;
    harness.viewportChanged();
    harness.clock.runFrames(20);

    assert.deepEqual(harness.scrollCalls, [[0, 0]]);
    assert.equal(harness.root.getAttribute(keyboardAttribute), "false");
    assert.equal(harness.root.getAttribute(lockAttribute), "false");
    assert.equal(harness.root.style.getPropertyValue(heightProperty), "");
    assert.equal(harness.root.style.getPropertyValue(topProperty), "");
  });

  await suite.test(
    "re-baselines rotation and split-view width changes",
    async () => {
      const harness = await createHarness();
      const first = harness.input();
      harness.focus(first);
      harness.viewport.height = 450;
      harness.viewportChanged();

      harness.window.innerWidth = 700;
      Object.assign(harness.viewport, { height: 400, width: 700 });
      harness.window.emit("resize");
      harness.viewport.height = 650;
      harness.viewportChanged();
      harness.clock.runFrames(20);
      assert.deepEqual(harness.scrollCalls, [[0, 0]]);
      assert.equal(
        harness.root.style.getPropertyValue(heightProperty),
        "650px",
      );
      assert.equal(harness.root.style.getPropertyValue(topProperty), "0px");

      harness.blur(first);
      harness.clock.runFrame();
      assert.equal(harness.root.getAttribute(lockAttribute), "false");

      harness.focus(harness.input());
      harness.viewport.height = 520;
      harness.viewportChanged();
      assert.equal(harness.root.getAttribute(keyboardAttribute), "true");
      assert.equal(harness.root.style.getPropertyValue(widthProperty), "700px");
    },
  );
});
