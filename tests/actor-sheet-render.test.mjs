import assert from "node:assert/strict";
import test from "node:test";
import "./mock-globals.mjs";
import { prepareActorSheetRenderOptions } from "../module/actor/actor-sheet-render.js";

const RENDER_STATES = Object.freeze({
  CLOSED: -1, CLOSING: -2, ERROR: -3, NONE: 0, RENDERED: 2, RENDERING: 1
});

class TokenDocumentFixture {
  constructor(id) {
    Object.defineProperty(this, "_id", { value: id, enumerable: true });
    this.sheet = { render: options => ({ token: this, options }) };
  }
}

// A deliberately recursive options merge models the V14 failure boundary.
// Unlike Object.assign, it traverses custom document instances as core does.
function mergeRenderOptions(target, incoming) {
  for (const [key, value] of Object.entries(incoming)) {
    if (!Object.hasOwn(target, key)) continue;
    if (value && target[key] && typeof value === "object" && typeof target[key] === "object") {
      mergeRenderOptions(target[key], value);
    } else {
      target[key] = value;
    }
  }
}

class LegacyActorSheetFixture {
  static RENDER_STATES = RENDER_STATES;
  get token() { return this.object.token || this.options.token || null; }
  async close() {
    this.options.token = null;
    this._state = RENDER_STATES.CLOSED;
  }
  async _render(force = false, options = {}) {
    if ([RENDER_STATES.CLOSING, RENDER_STATES.RENDERING].includes(this._state)) return;
    if (!force && this._state <= RENDER_STATES.NONE) return;
    this._state = RENDER_STATES.RENDERING;
    mergeRenderOptions(this.options, options);
    await this.getData(this.options);
    this._state = RENDER_STATES.RENDERED;
  }
}

globalThis.ActorSheet = LegacyActorSheetFixture;
globalThis.FormApplication = class {};
const { CyberpunkActorSheet } = await import("../module/actor/actor-sheet.js");

function createSheet({ state = RENDER_STATES.NONE, token = null, actorToken = null } = {}) {
  const sheet = Object.create(CyberpunkActorSheet.prototype);
  sheet.options = { token, width: 1200, editable: true, tabs: [{ initial: "skills" }] };
  sheet.object = { token: actorToken };
  sheet._state = state;
  sheet.getData = async () => ({});
  return sheet;
}

test("a naive V14 recursive options merge reproduces the read-only TokenDocument failure", () => {
  const token = new TokenDocumentFixture("scene-token");
  assert.throws(() => mergeRenderOptions({ token }, { token }), /read only property '_id'/);
});

test("token options are assigned by identity and omitted from the recursive merge", () => {
  const priorToken = new TokenDocumentFixture("prior-token");
  const token = new TokenDocumentFixture("scene-token");
  const sheet = createSheet({ token: priorToken });
  const options = Object.freeze({ token, width: 1000, focus: true });
  const prepared = prepareActorSheetRenderOptions(sheet, true, options);
  assert.equal(sheet.options.token, token);
  assert.deepEqual(prepared, { width: 1000, focus: true });
  assert.equal(options.token, token, "the caller's options remain intact");
  assert.equal(priorToken._id, "prior-token", "the previously cached document is not mutated");
});

test("actual sheet render succeeds after a failed token render and retains the live token", async () => {
  const token = new TokenDocumentFixture("scene-token");
  const sheet = createSheet();
  sheet.getData = async () => { throw new Error("An unrelated first-render failure"); };
  await assert.rejects(sheet._render(true, { token }), /first-render failure/);
  // Application#render records ERROR when its _render promise rejects.
  sheet._state = RENDER_STATES.ERROR;
  sheet.getData = async options => {
    assert.equal(options.token, token);
    assert.equal(sheet.token, token);
    assert.equal(sheet.token.sheet.render({ force: true }).token, token);
  };
  await sheet._render(true, { token, width: 1050 });
  assert.equal(sheet._state, RENDER_STATES.RENDERED);
  assert.equal(sheet.options.width, 1050);
});

test("re-rendering from another linked token replaces context without changing either document", async () => {
  const first = new TokenDocumentFixture("first-token");
  const second = new TokenDocumentFixture("second-token");
  const sheet = createSheet();
  await sheet._render(true, { token: first });
  await sheet._render(true, { token: second });
  assert.equal(sheet.token, second);
  assert.equal(first._id, "first-token");
  assert.equal(second._id, "second-token");
});

test("synthetic actor token retains priority over render options", async () => {
  const syntheticToken = new TokenDocumentFixture("unlinked-token");
  const optionToken = new TokenDocumentFixture("linked-token");
  const sheet = createSheet({ actorToken: syntheticToken });
  await sheet._render(true, { token: optionToken });
  assert.equal(sheet.token, syntheticToken);
  assert.equal(sheet.object.token, syntheticToken);
});

test("close and reopen from the sidebar restores prototype-token context", async () => {
  const sheet = createSheet();
  await sheet._render(true, { token: new TokenDocumentFixture("scene-token") });
  await sheet.close();
  await sheet._render(true);
  assert.equal(sheet.options.token, null);
  assert.equal(sheet.token, null);
});

test("omitted token retains context while explicit null clears it", async () => {
  const token = new TokenDocumentFixture("scene-token");
  const sheet = createSheet({ token, state: RENDER_STATES.RENDERED });
  await sheet._render(false, { width: 1100 });
  assert.equal(sheet.token, token);
  await sheet._render(true, { token: null });
  assert.equal(sheet.token, null);
});

test("skipped or concurrent renders do not replace the active token context", async () => {
  const original = new TokenDocumentFixture("active-token");
  const replacement = new TokenDocumentFixture("ignored-token");
  for (const [state, force] of [
    [RENDER_STATES.CLOSING, true], [RENDER_STATES.RENDERING, true],
    [RENDER_STATES.NONE, false], [RENDER_STATES.CLOSED, false], [RENDER_STATES.ERROR, false]
  ]) {
    const sheet = createSheet({ token: original, state });
    await sheet._render(force, { token: replacement });
    assert.equal(sheet.token, original);
    assert.equal(sheet._state, state);
  }
});
