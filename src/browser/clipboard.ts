type TextControlSelection = {
  direction: "backward" | "forward" | "none";
  end: number;
  start: number;
};

type ClipboardWithWrite = Clipboard & {
  write?: (items: readonly ClipboardItem[]) => Promise<void>;
};

function captureTextControlSelection(
  element: Element | null,
): TextControlSelection | null {
  if (
    !element ||
    !("selectionStart" in element) ||
    !("selectionEnd" in element) ||
    !("selectionDirection" in element) ||
    !("setSelectionRange" in element)
  ) {
    return null;
  }

  try {
    const control = element as HTMLInputElement | HTMLTextAreaElement;
    if (control.selectionStart === null || control.selectionEnd === null) {
      return null;
    }
    return {
      direction: control.selectionDirection ?? "none",
      end: control.selectionEnd,
      start: control.selectionStart,
    };
  } catch {
    return null;
  }
}

function focusWithoutScrolling(element: Element | null): void {
  if (!element || !("focus" in element)) {
    return;
  }

  const focus = (element as HTMLElement).focus;
  if (typeof focus !== "function") {
    return;
  }

  try {
    focus.call(element, { preventScroll: true });
  } catch {
    try {
      focus.call(element);
    } catch {
      // Focus restoration is best-effort if the original node was removed.
    }
  }
}

function restoreTextControlSelection(
  element: Element | null,
  selection: TextControlSelection | null,
): void {
  if (!element || !selection || !("setSelectionRange" in element)) {
    return;
  }

  try {
    (element as HTMLInputElement | HTMLTextAreaElement).setSelectionRange(
      selection.start,
      selection.end,
      selection.direction,
    );
  } catch {
    // The original control may have changed type or become disconnected.
  }
}

export function copyTextWithExecCommand(
  text: string,
  ownerDocument: Document = document,
): void {
  const selection = ownerDocument.getSelection();
  const savedRanges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) =>
        selection.getRangeAt(index).cloneRange(),
      )
    : [];
  const activeElement = ownerDocument.activeElement;
  const textControlSelection = captureTextControlSelection(activeElement);
  const textarea = ownerDocument.createElement("textarea");

  textarea.value = text;
  textarea.readOnly = true;
  textarea.tabIndex = -1;
  textarea.setAttribute("aria-hidden", "true");
  Object.assign(textarea.style, {
    border: "0",
    fontSize: "16px",
    height: "1px",
    left: "-9999px",
    margin: "0",
    opacity: "0",
    padding: "0",
    pointerEvents: "none",
    position: "fixed",
    top: "0",
    width: "1px",
  });

  const container = ownerDocument.body ?? ownerDocument.documentElement;
  container.appendChild(textarea);

  try {
    focusWithoutScrolling(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);

    if (
      typeof ownerDocument.execCommand !== "function" ||
      !ownerDocument.execCommand("copy")
    ) {
      throw new Error("Legacy clipboard copy was rejected.");
    }
  } finally {
    textarea.remove();
    focusWithoutScrolling(activeElement);
    restoreTextControlSelection(activeElement, textControlSelection);

    if (selection) {
      try {
        selection.removeAllRanges();
        for (const range of savedRanges) {
          selection.addRange(range);
        }
      } catch {
        // A copied action may synchronously replace its original selection.
      }
    }
  }
}

async function extractPlainText(
  items: readonly ClipboardItem[],
): Promise<string | null> {
  for (const item of items) {
    if (!item.types.includes("text/plain")) {
      continue;
    }
    return (await item.getType("text/plain")).text();
  }
  return null;
}

function createClipboardFacade(
  nativeClipboard: ClipboardWithWrite | undefined,
): Clipboard {
  const target = nativeClipboard ?? (Object.create(null) as ClipboardWithWrite);
  const nativeWrite = nativeClipboard?.write;

  const writeText = async (text: string): Promise<void> => {
    const normalizedText = String(text);
    if (nativeClipboard && typeof nativeClipboard.writeText === "function") {
      try {
        await nativeClipboard.writeText(normalizedText);
        return;
      } catch {
        // HTTP origins and denied permissions use the legacy selection path.
      }
    }

    copyTextWithExecCommand(normalizedText);
  };

  const write = async (items: readonly ClipboardItem[]): Promise<void> => {
    let nativeError: unknown;
    if (nativeClipboard && typeof nativeWrite === "function") {
      try {
        await nativeWrite.call(nativeClipboard, items);
        return;
      } catch (error) {
        nativeError = error;
      }
    }

    const plainText = await extractPlainText(items);
    if (plainText === null) {
      throw (
        nativeError ??
        new Error("Legacy clipboard copy only supports text/plain data.")
      );
    }
    copyTextWithExecCommand(plainText);
  };

  return new Proxy(target, {
    get(proxyTarget, property) {
      if (property === "writeText") {
        return writeText;
      }
      if (property === "write" && typeof nativeWrite === "function") {
        return write;
      }

      const value = Reflect.get(proxyTarget, property, proxyTarget);
      return typeof value === "function" ? value.bind(proxyTarget) : value;
    },
  });
}

export function installClipboardCompatibility(): void {
  const navigatorObject = window.navigator;
  let nativeClipboard: ClipboardWithWrite | undefined;
  try {
    nativeClipboard = navigatorObject.clipboard as
      | ClipboardWithWrite
      | undefined;
  } catch {
    nativeClipboard = undefined;
  }

  const clipboard = createClipboardFacade(nativeClipboard);
  const descriptor = {
    configurable: true,
    enumerable: true,
    value: clipboard,
  } satisfies PropertyDescriptor;

  try {
    Object.defineProperty(navigatorObject, "clipboard", descriptor);
    return;
  } catch (ownPropertyError) {
    const prototype = Object.getPrototypeOf(navigatorObject) as object | null;
    const prototypeDescriptor = prototype
      ? Object.getOwnPropertyDescriptor(prototype, "clipboard")
      : undefined;
    if (prototype && prototypeDescriptor?.configurable) {
      Object.defineProperty(prototype, "clipboard", descriptor);
      return;
    }

    console.warn(
      "[clipboard-compat] could not install the clipboard fallback",
      ownPropertyError,
    );
  }
}
