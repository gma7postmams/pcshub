/** Labels for page/section keys from the access model */
export const keyLabels = (model) => Object.fromEntries(model.catalog.flatMap((p) => [[p.key, p.label], ...p.sections.map((x) => [x.key, x.label])]));
