/**
 * The class-name helper the shadcn registry uses.
 *
 * `cn` is a drop-in replacement for `twMerge(clsx(...))`: it accepts clsx-style arguments
 * (strings, arrays, objects, conditionals) and resolves Tailwind conflicts so a caller's
 * `className="px-8"` beats a component's base `px-4`.
 *
 * The generated components import `cn` from the package directly; this module exists so
 * `@/lib/utils` (the alias in components.json) resolves to the same single implementation for
 * anything that prefers the alias.
 */
export { cn } from "cn";
