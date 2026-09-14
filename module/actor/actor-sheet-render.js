/**
 * Keep a live TokenDocument out of ApplicationV1's recursive options merge.
 *
 * Core retains the token reference after a failed render. Retrying from the
 * canvas would merge the document into itself, including its read-only _id.
 * Assign the reference atomically so ActorSheet's token getter and configure
 * button still address the real token, not a serialized copy of it.
 */
export function prepareActorSheetRenderOptions(sheet, force, options = {}) {
  const renderOptions = { ...options };
  if (!Object.hasOwn(renderOptions, "token")) return renderOptions;

  const token = renderOptions.token;
  delete renderOptions.token;

  // Match ApplicationV1's render guards: a rejected render must not replace
  // the token context of an in-flight render or a closing/unopened sheet.
  const states = sheet.constructor.RENDER_STATES;
  const skipped = states && (
    [states.CLOSING, states.RENDERING].includes(sheet._state)
    || (!force && sheet._state <= states.NONE)
  );
  if (!skipped) sheet.options.token = token;
  return renderOptions;
}
