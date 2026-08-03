/**
 * Local stand-in for the `node-domexception` npm package, which is deprecated at
 * EVERY published version ("Use your platform's native DOMException instead") —
 * there is no clean version to update to. It is still required by fetch-blob,
 * which the latest node-fetch pins, which Google's client libraries pin.
 *
 * Node has had DOMException as a global since v17, so the entire package is this
 * line. Wired in through the `overrides` field in the root package.json;
 * consumers `import DOMException from 'node-domexception'`, and a CJS
 * module.exports is exactly what that default import receives.
 */
module.exports = globalThis.DOMException;
