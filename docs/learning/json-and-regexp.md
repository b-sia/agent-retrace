# JSON conversion and regular expressions

Node concepts used by `src/match/normalize.ts`.

## `JSON.stringify` drops things quietly

Python's `json.dumps` raises `TypeError` for anything it cannot encode. `JSON.stringify` mostly
does not:

- `undefined`, functions and symbols are left out of objects and written as `null` in arrays.
- `NaN` and `Infinity` become `null`; `-0` becomes `0`.
- An object with a `toJSON()` method is replaced by its result first. `Date` has one, so a date
  becomes its ISO string.
- `Map` and `Set` have no enumerable own properties, so both become `{}`.
- Only a `bigint` or a circular reference throws, with a message that does not say where.

`toJsonArgs` follows the same rules, so tool arguments mean the same thing they would in a fetch
body, with two changes: an error names the path (`args[1].items[0].n`), and `Map`/`Set` throw
instead of turning into `{}`, which would let two different maps match. `AbortSignal` is dropped
like a function, because the Vercel AI SDK passes one to every tool and it says nothing about what
the tool was asked to do.

## Sparse arrays

`[1, , 3]` has a hole at index 1, not an `undefined`. `Array.prototype.map` skips holes and keeps
them in its output, so the hole would survive. `Array.from(arr, fn)` visits every index, so the
hole is seen as `undefined` and becomes `null`, as in JSON.

## A `g` regex has state

A `RegExp` with the `g` (or `y`) flag remembers `lastIndex` between `exec`/`test` calls, so
sharing one between calls can make it skip matches. Python's and Go's compiled patterns carry no
such state. `redactDeep` copies each user pattern with `new RegExp(source, flags)`, adding `g` so
`String.prototype.replace` replaces every match rather than only the first, and the user's own
object is never touched.

Secrets are literal strings, so they are escaped before being joined into one alternation
(`a|b|c`, longest first). One pass means `[REDACTED]` written for one secret is never rescanned for
another.

## `Object.hasOwn`

`"toString" in {}` is `true`, because `in` walks the prototype chain. `Object.hasOwn(obj, key)`
checks only the object's own keys, like `key in d` for a Python dict, so an ignore path named
`constructor` does not find something that is not in the data.
