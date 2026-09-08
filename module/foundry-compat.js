/**
 * Resolve Handlebars helpers across Foundry's legacy globals (V10-V12) and
 * the public namespaced API used by V13+.
 */
export function getFoundryHandlebarsFunction(name) {
  const legacy = globalThis[name];
  if(typeof legacy === "function") return legacy.bind(globalThis);

  const handlebarsApi = globalThis.foundry?.applications?.handlebars;
  const modern = handlebarsApi?.[name];
  return typeof modern === "function" ? modern.bind(handlebarsApi) : undefined;
}

export async function renderFoundryTemplate(path, data) {
  const renderer = getFoundryHandlebarsFunction("renderTemplate");
  if(!renderer) throw new Error("Foundry Handlebars renderTemplate API is unavailable.");
  return renderer(path, data);
}

export async function loadFoundryTemplates(paths) {
  const loader = getFoundryHandlebarsFunction("loadTemplates");
  if(!loader) throw new Error("Foundry Handlebars loadTemplates API is unavailable.");
  return loader(paths);
}
