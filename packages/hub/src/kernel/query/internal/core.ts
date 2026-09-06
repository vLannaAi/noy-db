/**
 * #1458 — how an extension group's methods reach `Query.prototype`.
 *
 * Each group defines its half of the builder as a MIXIN CLASS whose method
 * bodies moved out of `builder.ts` unchanged — `this.plan`, `this.source`,
 * `this.joinContext` and the rest still resolve, because TypeScript's
 * `private` is a compile-time construct and a method installed on the
 * prototype reads them like any other property. The mixin declares those
 * fields with `declare`, which emits nothing.
 *
 * ⭐ **Why a mixin CLASS rather than a file of `Query.prototype.x = function`
 * assignments.** The bodies are the point: several are 100+ lines carrying
 * prose that explains a decision, and a mechanical rewrite into assignment
 * form would have touched every one of them. As class methods they moved
 * byte-for-byte, so the diff shows a relocation rather than a rewrite — and an
 * overload set (`join`, `joinOn`, `aggregate`, `groupBy` all have them)
 * survives, which an assignment form cannot express.
 */

/**
 * Copy a mixin's prototype methods onto a target prototype, replacing the Find
 * stubs.
 *
 * `getOwnPropertyNames` rather than `Object.assign`: class methods are
 * non-enumerable prototype properties, so `assign` copies nothing at all —
 * silently, leaving every stub in place. Descriptors are copied whole so a
 * getter stays a getter.
 */
export function installMethods(target: object, mixin: { prototype: object }): void {
  for (const name of Object.getOwnPropertyNames(mixin.prototype)) {
    if (name === 'constructor') continue
    const desc = Object.getOwnPropertyDescriptor(mixin.prototype, name)
    if (desc) Object.defineProperty(target, name, desc)
  }
}
