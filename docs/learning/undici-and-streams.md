# undici, dispatchers and streams

Node concepts used by `src/http/*`.

## fetch is undici

Node's global `fetch` is not a C library or a thin wrapper over `http`. It is [undici](https://undici.nodejs.org), an HTTP client written in JavaScript and bundled into Node (Node 22 bundles undici 6, Node 24 bundles 7). Python's `requests` and Go's `http.Client` are comparable in role, but neither lets you swap out the transport after the fact the way undici does.

## What a dispatcher is

Every undici request ends in `dispatcher.dispatch(options, handler)`. The dispatcher (an `Agent`, which owns connection pools) opens or reuses a connection and calls back into the `handler` as the response arrives. `fetch` looks the dispatcher up on every call under `globalThis[Symbol.for("undici.globalDispatcher.1")]`. Replacing that object with a wrapper catches every request, including those from SDK clients built long before the test started. That is why `installInterceptor` wraps the dispatcher with a `Proxy` instead of replacing `fetch`: a client holding a reference to the old `fetch` function would never see the patch.

A `Proxy` forwards every property access to the original object unless the `get` trap says otherwise. Here only `dispatch` is replaced and everything else is returned bound to the original.

## Handler callbacks

A handler is a plain object of callbacks, called in this order:

- `onConnect(abort)`: the request is about to be sent; `abort(err)` cancels it.
- `onHeaders(status, rawHeaders, resume, statusText)`: `rawHeaders` is a flat `Buffer[]` of `[name, value, name, value, ...]`, not an object.
- `onData(chunk)`: zero or more times.
- `onComplete(trailers)` or `onError(err)`: exactly one of them, last.

Newer undici versions also accept a controller-style handler (`onRequestStart(controller)`, `onResponseStart`, `onResponseData`, `onResponseEnd`, `onResponseError`). undici decides which family a handler uses by looking at whether it has an `onRequestStart` method, so a wrapper handler must have only the family of the handler it wraps. A wrapper with both would make undici call methods the inner handler does not have, and the response would vanish.

## Backpressure

`onHeaders` and `onData` return a boolean. `false` means "my buffer is full, stop sending until I call `resume`". It is how a slow reader slows down the socket, like a blocking `Write` in Go. Replay ignores it: the whole recorded body is already in memory, so pausing would save nothing.

## setImmediate vs process.nextTick

Both schedule a callback, but at different points of the event loop. `process.nextTick` callbacks run as soon as the current operation finishes, before the loop moves on to I/O. A loop that schedules the next chunk with `nextTick` therefore runs to the end before any I/O callback gets a turn, and the SDK would see all chunks in one read. `setImmediate` runs after pending I/O callbacks, so each replayed chunk is delivered in a separate turn of the loop, like network data.

## fetch decompresses, the dispatcher does not

When a server sends `content-encoding: gzip`, `fetch` inflates the body on top of the dispatcher. What the dispatcher (and so the interceptor) sees is the compressed bytes. A recording must hold readable text, so `captureResponse` inflates it with `node:zlib` (gzip, deflate, brotli). On replay the body is plain, so `content-encoding` and `content-length` are never sent; with the header, `fetch` would try to inflate plain text and fail.

## Patching built-in modules

`require("node:https")` returns one shared exports object, and assigning `https.request = wrapper` changes what every `require` and default import sees. ESM named imports are different: `import { request } from "node:https"` binds to a copy of the export made when the module was created, so the assignment is not visible through it. `syncBuiltinESMExports()` from `node:module` refreshes those copies from the CommonJS object. It only updates live bindings of built-in modules, so call it after patching.
