/* The completeness verdict for one localized field, next to its title.
 *
 * It calls the same `missingLocales` the publish gate calls, so a form can never look complete
 * while validation would refuse it.
 */

import { missingLocales } from "@hkstories/core";

export function LocaleGap({ field }: { field: unknown }) {
  const missing = missingLocales(field);
  if (missing.length === 0) {
    return <span className="ml-2 text-[10px] text-emerald-500">三語齊備</span>;
  }
  return <span className="ml-2 text-[10px] text-amber-500">缺 {missing.join(" / ")}</span>;
}
