# Async context and the replay session

Node concepts used by `src/session.ts` and `src/runtime.ts`.

## The problem: which test is this request from?

An HTTP interceptor sits below the SDK. When a request arrives it must know which `replay()` call,
and so which recording, it belongs to. The SDK does not pass that along, and tests in one file may
run side by side (`test.concurrent`).

A global `currentSession` variable breaks as soon as two tests overlap:

```ts
let current: Session; // shared by every test in the process
test.concurrent("a", () => replay("a", run)); // sets current = A
test.concurrent("b", () => replay("b", run)); // sets current = B, while A is awaiting
// A's next request now lands in B's recording.
```

Single-threaded does not mean sequential. Every `await` hands control to other work, so overlapping
tests interleave at each await.

## `AsyncLocalStorage`

`AsyncLocalStorage` (from `node:async_hooks`) stores a value for the duration of a call, including
everything it starts: promises, timers, callbacks, `await` continuations.

```ts
als.run(session, () => fn()); // inside fn and all it awaits, als.getStore() === session
als.getStore(); // anywhere in that async tree; undefined outside it
```

Comparisons:

- **Python `contextvars`**: the same idea. `asyncio` copies the context into each task, and
  `ContextVar.get()` reads it. `als.run` is like `ctx.run(fn)`.
- **Go `context.Context`**: Go passes the context by hand as the first argument of every function.
  Node cannot, because the SDK's code between `fn` and the interceptor does not know about it. ALS
  is the implicit version of that parameter.

Two tests that overlap each get their own store, so `als.getStore()` in the interceptor returns the
right session for each.

## Why the store lives on `globalThis`

`runtime()` creates one `AsyncLocalStorage` and keeps it on `globalThis` (see
`runtime-singleton-and-errors.md`). If each copy of the library made its own, `als.run` in copy B
would be invisible to `als.getStore()` in the interceptor that copy A installed. One shared object
means any copy can start a session and any copy can see it.

## The session is plain state, not a global

`Session` holds everything for one `replay()` call: the recording, which steps are consumed, what
was recorded live. It has no I/O of its own; it is handed a `save` function. That keeps the matching
rules testable with plain objects and no sockets.

## Why matching does not depend on completion order

An agent may issue two requests at once (`Promise.all`). Which response arrives first is up to the
network, so a design based on "the next request is step N" would fail randomly. Instead:

- A request takes a sequence number when it is **issued**, not when it finishes.
- It matches the earliest unconsumed recorded step with the same key.
- A recording is saved ordered by sequence number, whatever order the commits arrive in.

Two requests with different keys match whichever order they come in. Two identical requests consume
identical recorded steps in recorded order.

## `closed` and late requests

`finish()` sets `closed` before it saves. A request that starts after the replay ended, for example
a forgotten background task, then finds a closed session and is refused instead of silently
changing the recording. A request that started inside the replay but is still in flight when it
ends is not recorded: its `commit` arrives after `closed` and is ignored, because the recording is
already being written. Await all of the agent's work inside `replay()`.
