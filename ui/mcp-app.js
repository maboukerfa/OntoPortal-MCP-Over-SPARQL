/*
  MCP Apps bridge shared by the views: JSON-RPC 2.0 over postMessage with the
  host (protocol 2026-01-26), the host's theme, and the frame's size. The
  server inlines this file into each view it serves; a browser opening a view
  from disk loads it beside the HTML.

      view ──ui/initialize──▶ host ──hostContext──▶ view ──initialized──▶ host
      host ──ui/notifications/tool-result──▶ McpApp.on(...) handler
      view ──McpApp.callTool / openLink / requestDisplayMode──▶ host

  Usage:

      McpApp.on(McpApp.Method.ToolResult, render);
      McpApp.connect({ name: "my-view", version: "1.0.0" });
*/
"use strict";

const McpApp = (() => {
  const PROTOCOL_VERSION = "2026-01-26";

  const Method = {
    Initialize: "ui/initialize",
    Initialized: "ui/notifications/initialized",
    ToolInput: "ui/notifications/tool-input",
    ToolResult: "ui/notifications/tool-result",
    ToolCancelled: "ui/notifications/tool-cancelled",
    ContextChanged: "ui/notifications/host-context-changed",
    Teardown: "ui/resource-teardown",
    Ping: "ping",
    SizeChanged: "ui/notifications/size-changed",
    OpenLink: "ui/open-link",
    DisplayMode: "ui/request-display-mode",
    CallTool: "tools/call",
  };

  const DisplayMode = { Inline: "inline", Fullscreen: "fullscreen" };

  /** JSON-RPC's code for a method nobody handles. */
  const METHOD_NOT_FOUND = -32601;

  /** The frame's height inline, unless the view asks for another or the host caps it lower. */
  const DEFAULT_INLINE_HEIGHT = 560;

  const context = {};
  const handlers = {};
  const pending = new Map();
  let nextId = 1;
  let inlineHeight = DEFAULT_INLINE_HEIGHT;
  let fontsApplied = false;
  let contextListener = () => {};

  // --- Messages --------------------------------------------------------------------

  function send(message) {
    window.parent.postMessage({ jsonrpc: "2.0", ...message }, "*");
  }

  function request(method, params) {
    const id = nextId++;
    send({ id, method, params });
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  }

  function notify(method, params) {
    send({ method, params });
  }

  /** What the host may send whatever the view does. */
  const builtins = {
    [Method.ContextChanged]: (changes) => applyContext(changes),
    [Method.Teardown]: () => ({}),
    [Method.Ping]: () => ({}),
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) {
      return;
    }

    const message = event.data;
    if (!message || message.jsonrpc !== "2.0") {
      return;
    }

    // An answer to one of our requests.
    if (message.method === undefined) {
      const waiting = pending.get(message.id);
      if (!waiting) {
        return;
      }

      pending.delete(message.id);
      if (message.error) {
        waiting.reject(new Error(message.error.message));
      } else {
        waiting.resolve(message.result);
      }
      return;
    }

    // A notification wants nothing back; a request wants an answer or an error.
    const handler = builtins[message.method] ?? handlers[message.method];
    const answer = handler ? handler(message.params ?? {}) : undefined;
    if (message.id === undefined) {
      return;
    }

    if (!handler) {
      send({ id: message.id, error: { code: METHOD_NOT_FOUND, message: `Unknown method ${message.method}` } });
      return;
    }
    send({ id: message.id, result: answer ?? {} });
  });

  // --- Host context: theme, fonts, display mode ------------------------------------

  function applyContext(changes) {
    Object.assign(context, changes);
    const root = document.documentElement;

    if (context.theme) {
      root.dataset.theme = context.theme;
      root.style.colorScheme = context.theme;
    }

    for (const [name, value] of Object.entries(context.styles?.variables ?? {})) {
      if (value) {
        root.style.setProperty(name, value);
      }
    }

    if (context.styles?.css?.fonts && !fontsApplied) {
      const style = document.createElement("style");
      style.textContent = context.styles.css.fonts;
      document.head.append(style);
      fontsApplied = true;
    }

    // A fixed height or fullscreen gives us the frame; otherwise we pick our own, within any cap.
    const dimensions = context.containerDimensions ?? {};
    root.classList.toggle("fills", context.displayMode === DisplayMode.Fullscreen || "height" in dimensions);
    root.style.setProperty("--inline-height", `${Math.min(inlineHeight, dimensions.maxHeight ?? inlineHeight)}px`);

    contextListener(context);
  }

  /** Tell the host our size whenever it changes; it sizes the frame to match. */
  function watchSize() {
    let last = "";

    const report = () => {
      const width = Math.ceil(window.innerWidth);
      const height = Math.ceil(document.documentElement.getBoundingClientRect().height);
      if (`${width}x${height}` === last) {
        return;
      }

      last = `${width}x${height}`;
      notify(Method.SizeChanged, { width, height });
    };

    new ResizeObserver(() => requestAnimationFrame(report)).observe(document.body);
    report();
  }

  // --- API -------------------------------------------------------------------------

  return {
    Method,
    DisplayMode,
    /** The host context so far, merged with every change the host sends. */
    context,

    /** Handle a notification or request from the host; a request gets the return value as its answer. */
    on(method, handler) {
      handlers[method] = handler;
    },

    /** Called with the merged context after every change, theme and display mode included. */
    onContext(listener) {
      contextListener = listener;
    },

    /** The handshake. Call once, after registering handlers: the host sends nothing before it ends. */
    async connect(appInfo, options = {}) {
      inlineHeight = options.inlineHeight ?? DEFAULT_INLINE_HEIGHT;
      document.documentElement.style.setProperty("--inline-height", `${inlineHeight}px`);

      const result = await request(Method.Initialize, {
        appInfo,
        appCapabilities: { availableDisplayModes: [DisplayMode.Inline, DisplayMode.Fullscreen] },
        protocolVersion: PROTOCOL_VERSION,
      });

      applyContext(result?.hostContext ?? {});
      notify(Method.Initialized, {});
      watchSize();
    },

    /** Call a server tool through the host. Its result comes back here, not to the model. */
    callTool(name, args) {
      return request(Method.CallTool, { name, arguments: args });
    },

    openLink(url) {
      return request(Method.OpenLink, { url });
    },

    /** Ask for a display mode; the host answers with the one it chose. */
    async requestDisplayMode(mode) {
      const result = await request(Method.DisplayMode, { mode });
      applyContext({ displayMode: result?.mode ?? context.displayMode });
      return context.displayMode;
    },
  };
})();
