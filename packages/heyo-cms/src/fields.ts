/**
 * The field registry and every built-in type.
 *
 * Built-ins are declared with the same `defineField()` a third-party package
 * uses, so there is no privileged path into the registry (stage 9).
 */
export * from "./fields/index";
