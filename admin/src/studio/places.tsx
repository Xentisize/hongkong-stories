/* The four places of the studio, each in its own file.
 *
 * The shell imports from here, so the split is invisible to it; the file itself is now a map of
 * which place lives where rather than five components in a row.
 */

export { BuildPlace } from "@/studio/places/Build";
export { PackPlace } from "@/studio/places/Pack";
export { ShipPlace } from "@/studio/places/Ship";
export { StoryPlace } from "@/studio/places/Story";
