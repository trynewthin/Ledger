var __getOwnPropNames = Object.getOwnPropertyNames;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};

// ../../node_modules/.pnpm/zustand@5.0.15_@types+react@19.2.18_react@19.2.8/node_modules/zustand/vanilla.js
var require_vanilla = __commonJS({
  "../../node_modules/.pnpm/zustand@5.0.15_@types+react@19.2.18_react@19.2.8/node_modules/zustand/vanilla.js"(exports) {
    "use strict";
    var createStoreImpl = (createState) => {
      let state;
      const listeners = /* @__PURE__ */ new Set();
      const setState = (partial, replace) => {
        const nextState = typeof partial === "function" ? partial(state) : partial;
        if (!Object.is(nextState, state)) {
          const previousState = state;
          state = (replace != null ? replace : typeof nextState !== "object" || nextState === null) ? nextState : Object.assign({}, state, nextState);
          listeners.forEach((listener) => listener(state, previousState));
        }
      };
      const getState = () => state;
      const getInitialState = () => initialState;
      const subscribe = (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      };
      const api = { setState, getState, getInitialState, subscribe };
      const initialState = state = createState(setState, getState, api);
      return api;
    };
    var createStore = ((createState) => createState ? createStoreImpl(createState) : createStoreImpl);
    exports.createStore = createStore;
  }
});

// ../../node_modules/.pnpm/zustand@5.0.15_@types+react@19.2.18_react@19.2.8/node_modules/zustand/react.js
var require_react = __commonJS({
  "../../node_modules/.pnpm/zustand@5.0.15_@types+react@19.2.18_react@19.2.8/node_modules/zustand/react.js"(exports) {
    "use strict";
    var React = __require("react");
    var vanilla = require_vanilla();
    var identity = (arg) => arg;
    function useStore(api, selector = identity) {
      const slice = React.useSyncExternalStore(
        api.subscribe,
        React.useCallback(() => selector(api.getState()), [api, selector]),
        React.useCallback(() => selector(api.getInitialState()), [api, selector])
      );
      React.useDebugValue(slice);
      return slice;
    }
    var createImpl = (createState) => {
      const api = vanilla.createStore(createState);
      const useBoundStore = (selector) => useStore(api, selector);
      Object.assign(useBoundStore, api);
      return useBoundStore;
    };
    var create = ((createState) => createState ? createImpl(createState) : createImpl);
    exports.create = create;
    exports.useStore = useStore;
  }
});

// ../../node_modules/.pnpm/zustand@5.0.15_@types+react@19.2.18_react@19.2.8/node_modules/zustand/index.js
var require_index = __commonJS({
  "../../node_modules/.pnpm/zustand@5.0.15_@types+react@19.2.18_react@19.2.8/node_modules/zustand/index.js"(exports) {
    var vanilla = require_vanilla();
    var react = require_react();
    Object.keys(vanilla).forEach(function(k) {
      if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
        enumerable: true,
        get: function() {
          return vanilla[k];
        }
      });
    });
    Object.keys(react).forEach(function(k) {
      if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
        enumerable: true,
        get: function() {
          return react[k];
        }
      });
    });
  }
});
export default require_index();
