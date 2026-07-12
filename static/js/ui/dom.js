// @ts-check

/**
 * Return the first matching element from a root node.
 *
 * The application owns its template, so missing selectors indicate a
 * programming error and are surfaced immediately instead of failing later.
 *
 * @param {string} selector
 * @param {ParentNode} [root]
 * @returns {any}
 */
export function $(selector, root = document) {
  const element = root.querySelector(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

/**
 * Return all matching elements from a root node as a regular array.
 * @param {string} selector
 * @param {ParentNode} [root]
 * @returns {any[]}
 */
export function $$(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}
