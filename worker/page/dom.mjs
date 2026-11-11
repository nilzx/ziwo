// How the admin page builds its elements, apart from the page so that Node
// can drive it with a stand-in document. Text is only ever text: nothing
// here parses markup.

/**
 * makeH returns h(tag, props, ...kids) for a document. Props: on<event>
 * listens, text sets textContent, false or null or undefined is left out,
 * true is an empty attribute, anything else an attribute. Kids are elements
 * or text, nested in arrays to any depth; null, undefined and false are
 * left out.
 * @param {Document} doc
 */
export function makeH(doc) {
  /** @param {string} tag @param {Record<string, unknown>} [props] @param {...unknown} kids @returns {HTMLElement} */
  return function h(tag, props = {}, ...kids) {
    const el = doc.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === false || v === null) continue;
      if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), /** @type {EventListener} */ (v));
      else if (k === "text") el.textContent = String(v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === undefined || kid === null || kid === false) continue;
      el.append(typeof kid === "object" ? /** @type {Node} */ (kid) : String(kid));
    }
    return el;
  };
}
